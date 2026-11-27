#import "Lynkeus.h"

#import <UIKit/UIKit.h>

// Touch synthesis uses private UIKit API (the technique KIF and Detox rely
// on). Nothing below `#if DEBUG` reaches a release binary: the symbols are
// simply not compiled, so App Store review never sees them.
#if DEBUG

@interface UITouch (LynkeusPrivate)
- (void)setPhase:(UITouchPhase)phase;
- (void)setTapCount:(NSUInteger)tapCount;
- (void)setTimestamp:(NSTimeInterval)timestamp;
- (void)setWindow:(UIWindow *)window;
- (void)setView:(UIView *)view;
- (void)_setLocationInWindow:(CGPoint)location resetPrevious:(BOOL)resetPrevious;
- (void)_setIsFirstTouchForView:(BOOL)first;
@end

@interface UIEvent (LynkeusPrivate)
- (void)_addTouch:(UITouch *)touch forDelayedDelivery:(BOOL)delayed;
- (void)_clearTouches;
@end

@interface UIApplication (LynkeusPrivate)
- (UIEvent *)_touchesEvent;
@end

static UIWindow *QaKeyWindow(void) {
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:UIWindowScene.class]) continue;
    for (UIWindow *window in ((UIWindowScene *)scene).windows) {
      if (window.isKeyWindow) return window;
    }
  }
  return UIApplication.sharedApplication.windows.firstObject;
}

static NSString *QaFieldText(UIView *view) {
  if ([view isKindOfClass:UITextField.class]) return ((UITextField *)view).text ?: @"";
  if ([view isKindOfClass:UITextView.class]) return ((UITextView *)view).text ?: @"";
  for (UIView *child in view.subviews) {
    NSString *found = QaFieldText(child);
    if (found) return found;
  }
  return nil;
}

// Every window the app's scenes show, front first: a higher level is in front, and among equals the later one.
static NSArray<UIWindow *> *QaWindowsFrontFirst(void) {
  NSMutableArray<UIWindow *> *windows = [NSMutableArray array];
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:UIWindowScene.class]) continue;
    for (UIWindow *window in ((UIWindowScene *)scene).windows) {
      if (!window.hidden && window.alpha > 0.01 && window.userInteractionEnabled) [windows addObject:window];
    }
  }
  NSArray<UIWindow *> *backFirst = [windows sortedArrayWithOptions:NSSortStable
                                                    usingComparator:^NSComparisonResult(UIWindow *a, UIWindow *b) {
                                                      if (a.windowLevel == b.windowLevel) return NSOrderedSame;
                                                      return a.windowLevel < b.windowLevel ? NSOrderedAscending : NSOrderedDescending;
                                                    }];
  return backFirst.reverseObjectEnumerator.allObjects;
}

static BOOL QaHasReactTag(UIView *view, NSInteger depth) {
  if (view.tag > 0) return YES;
  if (depth == 0) return NO;
  for (UIView *child in view.subviews) {
    if (QaHasReactTag(child, depth - 1)) return YES;
  }
  return NO;
}

// React Native tags the views it mounts; a window with none drew nothing of the app's React tree.
static BOOL QaIsReactWindow(UIWindow *window) {
  return QaHasReactTag(window, 12);
}

// The keyboard's windows span the whole screen. Lynkeus's touches go to the app under the keys, so the keys cover
// nothing; but iOS also presents its own prompts from there (AutoFill's Save Password, out of process), and those do.
static BOOL QaIsKeyboardWindow(UIWindow *window) {
  NSString *name = NSStringFromClass(window.class);
  return [name containsString:@"Keyboard"] || [name containsString:@"TextEffects"];
}

// React Native's own development overlay (RCTDevLoadingView's "Refreshing..." banner, a window of its own over the app)
// is neither the app's nor the system's. It is known by the class that handles its touches, never by its words; a
// gesture's targets are private, so a UIKit that names them otherwise leaves the banner listed, as before.
static BOOL QaIsDevToolingView(UIView *view, NSInteger depth) {
  for (UIGestureRecognizer *gesture in view.gestureRecognizers) {
    @try {
      for (id target in [gesture valueForKey:@"_targets"]) {
        id owner = [target valueForKey:@"_target"];
        if (owner && [NSStringFromClass([owner class]) containsString:@"DevLoadingView"]) return YES;
      }
    } @catch (__unused NSException *exception) {
    }
  }
  if (depth == 0) return NO;
  for (UIView *child in view.subviews) {
    if (QaIsDevToolingView(child, depth - 1)) return YES;
  }
  return NO;
}

static UIViewController *QaPresented(UIWindow *window) {
  UIViewController *top = window.rootViewController.presentedViewController;
  while (top.presentedViewController) top = top.presentedViewController;
  return top;
}

// What a finger at the point would land on, and in which window.
static UIView *QaHitInWindows(CGPoint point, UIWindow **landed) {
  for (UIWindow *window in QaWindowsFrontFirst()) {
    CGPoint local = [window convertPoint:point fromWindow:nil];
    UIView *hit = [window hitTest:local withEvent:nil];
    if (!hit) continue;
    if (QaIsKeyboardWindow(window)) {
      UIView *prompt = QaPresented(window).view;
      if (!prompt || ![hit isDescendantOfView:prompt]) continue;
    }
    if (landed) *landed = window;
    return hit;
  }
  return nil;
}

// The window touches at the point go to: the one in front there, as a finger's would.
static UIWindow *QaTouchWindow(CGPoint point) {
  UIWindow *landed = nil;
  QaHitInWindows(point, &landed);
  return landed ?: QaKeyWindow();
}

// The window React Native draws the app in, front first; the key window when none says so.
static UIWindow *QaAppWindow(void) {
  for (UIWindow *window in QaWindowsFrontFirst()) {
    if (!QaIsKeyboardWindow(window) && QaIsReactWindow(window)) return window;
  }
  return QaKeyWindow();
}

// A whole alert or sheet listens for touches, so a recognizer says nothing: a control, or UIKit's action views, does.
static BOOL QaActsOnTouch(UIView *view, UIView *stop) {
  for (UIView *at = view; at && at != stop; at = at.superview) {
    NSString *name = NSStringFromClass(at.class);
    if ([at isKindOfClass:UIControl.class] || [name containsString:@"ActionView"] || [name containsString:@"Button"]) return YES;
  }
  return NO;
}

static void QaCollectTexts(UIView *view, UIView *stop, NSMutableArray *items) {
  if (view.hidden || view.alpha < 0.01) return;
  NSString *text = nil;
  if ([view isKindOfClass:UILabel.class]) text = ((UILabel *)view).text;
  else if ([view isKindOfClass:UITextField.class] || [view isKindOfClass:UITextView.class]) text = QaFieldText(view);
  if (text.length > 0) {
    CGRect frame = [view convertRect:view.bounds toView:nil];
    [items addObject:@{
      @"text" : text,
      @"kind" : QaActsOnTouch(view, stop) ? @"button" : @"text",
      @"frame" : @[ @(frame.origin.x), @(frame.origin.y), @(frame.size.width), @(frame.size.height) ],
    }];
  }
  for (UIView *child in view.subviews) QaCollectTexts(child, stop, items);
}

static UITouch *QaMakeTouch(CGPoint point, UIWindow *window) {
  UITouch *touch = [[UITouch alloc] init];
  [touch setWindow:window];
  [touch _setLocationInWindow:point resetPrevious:YES];
  UIView *hit = [window hitTest:point withEvent:nil];
  [touch setView:hit ?: window];
  [touch setPhase:UITouchPhaseBegan];
  [touch setTapCount:1];
  [touch _setIsFirstTouchForView:YES];
  [touch setTimestamp:[[NSProcessInfo processInfo] systemUptime]];
  return touch;
}

static void QaSend(UITouch *touch, UITouchPhase phase, CGPoint point) {
  [touch _setLocationInWindow:point resetPrevious:NO];
  [touch setPhase:phase];
  [touch setTimestamp:[[NSProcessInfo processInfo] systemUptime]];
  UIEvent *event = [UIApplication.sharedApplication _touchesEvent];
  [event _clearTouches];
  [event _addTouch:touch forDelayedDelivery:NO];
  [UIApplication.sharedApplication sendEvent:event];
}

// UIKit resets gesture recognizers only once the run loop turns after a
// touch sequence ends. A new touch that begins before that reset lands in a
// recognizer whose registry is then wiped, and React Native's touch handler
// asserts on the orphaned Ended. Handing control back keeps taps distinct.
static void QaAfterSequence(RCTPromiseResolveBlock resolve) {
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.03 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    resolve(@YES);
  });
}

static UIView *QaFirstResponder(UIView *view) {
  if (view.isFirstResponder) return view;
  for (UIView *child in view.subviews) {
    UIView *found = QaFirstResponder(child);
    if (found) return found;
  }
  return nil;
}

static id<UIKeyInput> QaKeyInput(void) {
  UIView *responder = QaFirstResponder(QaKeyWindow());
  return [responder conformsToProtocol:@protocol(UIKeyInput)] ? (id<UIKeyInput>)responder : nil;
}

#endif

@implementation Lynkeus

- (NSString *)appId
{
  return [[NSBundle mainBundle] bundleIdentifier] ?: @"";
}

- (NSNumber *)isAvailable
{
#if DEBUG
  return @YES;
#else
  return @NO;
#endif
}

- (void)tap:(double)x y:(double)y holdMs:(double)holdMs
    resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
#if DEBUG
  dispatch_async(dispatch_get_main_queue(), ^{
    CGPoint point = CGPointMake(x, y);
    UIWindow *window = QaTouchWindow(point);
    if (!window) return reject(@"no_window", @"No key window", nil);
    UITouch *touch = QaMakeTouch(point, window);
    QaSend(touch, UITouchPhaseBegan, point);
    double hold = holdMs > 0 ? holdMs : 50;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(hold / 1000.0 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      QaSend(touch, UITouchPhaseEnded, point);
      QaAfterSequence(resolve);
    });
  });
#else
  reject(@"unavailable", @"Lynkeus touch synthesis is compiled out of release builds", nil);
#endif
}

- (void)swipe:(double)x1 y1:(double)y1 x2:(double)x2 y2:(double)y2 durationMs:(double)durationMs
      resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
#if DEBUG
  dispatch_async(dispatch_get_main_queue(), ^{
    CGPoint from = CGPointMake(x1, y1), to = CGPointMake(x2, y2);
    UIWindow *window = QaTouchWindow(from);
    if (!window) return reject(@"no_window", @"No key window", nil);
    UITouch *touch = QaMakeTouch(from, window);
    QaSend(touch, UITouchPhaseBegan, from);
    double duration = durationMs > 0 ? durationMs : 250;
    NSInteger steps = MAX(4, (NSInteger)(duration / 16.0));
    double stepSeconds = (duration / 1000.0) / steps;
    for (NSInteger i = 1; i <= steps; i++) {
      double t = (double)i / steps;
      CGPoint p = CGPointMake(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(stepSeconds * i * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        QaSend(touch, UITouchPhaseMoved, p);
        if (i == steps) {
          QaSend(touch, UITouchPhaseEnded, p);
          QaAfterSequence(resolve);
        }
      });
    }
  });
#else
  reject(@"unavailable", @"Lynkeus touch synthesis is compiled out of release builds", nil);
#endif
}

- (void)typeText:(NSString *)text resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
#if DEBUG
  dispatch_async(dispatch_get_main_queue(), ^{
    id<UIKeyInput> input = QaKeyInput();
    if (!input) return reject(@"no_input", @"No focused text input", nil);
    [text enumerateSubstringsInRange:NSMakeRange(0, text.length)
                             options:NSStringEnumerationByComposedCharacterSequences
                          usingBlock:^(NSString *ch, NSRange r, NSRange er, BOOL *stop) {
      [input insertText:ch];
    }];
    resolve(@YES);
  });
#else
  reject(@"unavailable", @"Lynkeus key synthesis is compiled out of release builds", nil);
#endif
}

- (void)deleteBackward:(double)count resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
#if DEBUG
  dispatch_async(dispatch_get_main_queue(), ^{
    id<UIKeyInput> input = QaKeyInput();
    if (!input) return reject(@"no_input", @"No focused text input", nil);
    for (NSInteger i = 0; i < (NSInteger)count; i++) [input deleteBackward];
    resolve(@YES);
  });
#else
  reject(@"unavailable", @"Lynkeus key synthesis is compiled out of release builds", nil);
#endif
}

- (void)dismissKeyboard:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
#if DEBUG
  dispatch_async(dispatch_get_main_queue(), ^{
    [QaFirstResponder(QaKeyWindow()) resignFirstResponder];
    resolve(@YES);
  });
#else
  reject(@"unavailable", @"Lynkeus is compiled out of release builds", nil);
#endif
}

// A single-line field submits through its delegate, which is where the return
// key lands; a multi-line one sees the newline and decides by submitBehavior.
- (void)submitEditing:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
#if DEBUG
  dispatch_async(dispatch_get_main_queue(), ^{
    UIResponder *responder = QaFirstResponder(QaKeyWindow());
    if ([responder isKindOfClass:[UITextField class]]) {
      UITextField *field = (UITextField *)responder;
      BOOL leaves = YES;
      if ([field.delegate respondsToSelector:@selector(textFieldShouldReturn:)]) leaves = [field.delegate textFieldShouldReturn:field];
      // What UIKit does after the key when the delegate agrees: end editing and give up the keyboard.
      if (leaves) {
        [field sendActionsForControlEvents:UIControlEventEditingDidEndOnExit];
        [field resignFirstResponder];
      }
      return resolve(@YES);
    }
    id<UIKeyInput> input = QaKeyInput();
    if (!input) return reject(@"no_input", @"No focused text input", nil);
    [input insertText:@"\n"];
    resolve(@YES);
  });
#else
  reject(@"unavailable", @"Lynkeus key synthesis is compiled out of release builds", nil);
#endif
}

// Synchronous: called on the JS thread, hit-tests on the main thread and
// waits. UIKit's hitTest is cheap, so this is microseconds per point.
- (NSString *)hitTest:(NSArray *)xs ys:(NSArray *)ys
{
#if DEBUG
  __block NSString *result = @"[]";
  void (^work)(void) = ^{
    NSUInteger count = MIN(xs.count, ys.count);
    NSMutableArray *chains = [NSMutableArray arrayWithCapacity:count];
    for (NSUInteger i = 0; i < count; i++) {
      CGPoint p = CGPointMake([xs[i] doubleValue], [ys[i] doubleValue]);
      // In whichever window is in front there: a view of another window (a system prompt, an alert) covers the app.
      UIView *view = QaHitInWindows(p, nil);
      NSMutableArray<NSNumber *> *chain = [NSMutableArray array];
      while (view) {
        if (view.tag > 0) [chain addObject:@(view.tag)];
        view = view.superview;
      }
      [chains addObject:chain];
    }
    NSData *json = [NSJSONSerialization dataWithJSONObject:chains options:0 error:nil];
    result = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
  };
  if (NSThread.isMainThread) work(); else dispatch_sync(dispatch_get_main_queue(), work);
  return result;
#else
  return @"[]";
#endif
}

// The shadow tree and the views agree on iOS, so there is nothing to correct.
- (NSString *)frames:(NSArray *)tags
{
  return @"[]";
}

// What windows the app's React tree did not draw show in front of it: a system prompt, an alert, a native SDK's
// sheet. Their words, each with its frame, and the frame they take; `null` when there is none. Synchronous, like hitTest.
- (NSString *)systemViews
{
#if DEBUG
  __block NSString *result = @"null";
  void (^work)(void) = ^{
    NSMutableArray *items = [NSMutableArray array];
    CGRect covers = CGRectNull;
    for (UIWindow *window in QaWindowsFrontFirst()) {
      UIView *root = window;
      if (QaIsDevToolingView(window, 4)) continue;
      if (QaIsKeyboardWindow(window)) {
        root = QaPresented(window).view;
        if (!root) continue;
      } else if (QaIsReactWindow(window)) {
        // Windows behind the app's own cannot be in front of it.
        break;
      }
      // A window can pass touches through everywhere but its own views (a toast's): only what catches one is in front.
      CGRect area = [root convertRect:root.bounds toView:nil];
      CGRect caught = CGRectNull;
      for (int gx = 0; gx < 6; gx++) {
        for (int gy = 0; gy < 12; gy++) {
          CGPoint p = CGPointMake(area.origin.x + area.size.width * (gx + 0.5) / 6, area.origin.y + area.size.height * (gy + 0.5) / 12);
          UIView *hit = [window hitTest:[window convertPoint:p fromWindow:nil] withEvent:nil];
          if (hit && [hit isDescendantOfView:root]) caught = CGRectUnion(caught, CGRectMake(p.x, p.y, 0, 0));
        }
      }
      if (CGRectIsNull(caught)) continue;
      // Each point that caught one stands for its cell of the grid.
      covers = CGRectUnion(covers, CGRectIntersection(area, CGRectInset(caught, -area.size.width / 12, -area.size.height / 24)));
      QaCollectTexts(root, window, items);
    }
    if (CGRectIsNull(covers)) return;
    NSDictionary *found = @{
      @"frame" : @[ @(covers.origin.x), @(covers.origin.y), @(covers.size.width), @(covers.size.height) ],
      @"items" : items,
    };
    NSData *json = [NSJSONSerialization dataWithJSONObject:found options:0 error:nil];
    result = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
  };
  if (NSThread.isMainThread) work(); else dispatch_sync(dispatch_get_main_queue(), work);
  return result;
#else
  return @"null";
#endif
}

// Synchronous, like hitTest: asked on the JS thread, read on the main one.
- (NSString *)texts:(NSArray *)tags
{
#if DEBUG
  __block NSString *result = @"[]";
  void (^work)(void) = ^{
    UIWindow *window = QaAppWindow();
    if (!window) return;
    NSMutableArray *texts = [NSMutableArray arrayWithCapacity:tags.count];
    for (NSNumber *tag in tags) {
      UIView *view = [window viewWithTag:tag.integerValue];
      [texts addObject:(view ? QaFieldText(view) : nil) ?: [NSNull null]];
    }
    NSData *json = [NSJSONSerialization dataWithJSONObject:texts options:0 error:nil];
    result = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
  };
  if (NSThread.isMainThread) work(); else dispatch_sync(dispatch_get_main_queue(), work);
  return result;
#else
  return @"[]";
#endif
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeLynkeusSpecJSI>(params);
}

+ (NSString *)moduleName
{
  return @"Lynkeus";
}

@end
