import { Platform } from 'react-native';
import { textTransformOf, transformText, type TextTransform } from 'lynkeus-agent/presentation';

// The host-only tree React Native Testing Library 14 renders, typed
// structurally so the package does not depend on the renderer's types.
export type ReactTestInstance = {
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly parent: ReactTestInstance | null;
  readonly children: (ReactTestInstance | string)[];
  readonly unstable_fiber?: Fiber | null;
};

export type Fiber = {
  type: unknown;
  memoizedProps: Record<string, unknown> | null;
  stateNode: unknown;
  return: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
};

type Named = { displayName?: string; name?: string };

// forwardRef and memo keep the real component's name on `render` / `type`.
export const fiberName = (fiber: Fiber): string => {
  const t = fiber.type as (Named & { render?: Named; type?: Named }) | string | null;
  if (typeof t === 'string') return t;
  if (!t) return 'anonymous';
  return t.displayName || t.name || t.render?.displayName || t.render?.name || t.type?.displayName || t.type?.name || 'anonymous';
};

type Animated = { value?: Record<string, unknown> } | undefined;

const has = (values: Record<string, unknown> | undefined): values is Record<string, unknown> => !!values && Object.keys(values).length > 0;

/**
 * A host's props as they stand now. Reanimated under jest keeps what its animations set in `jestAnimatedStyle` and
 * `jestAnimatedProps`, never in the props the view rendered with: a drawer that opened still read as closed (hidden
 * from accessibility, behind its screen) and a closed one as open. Its live values win, as they do on a device.
 */
export const liveProps = (node: ReactTestInstance): Record<string, unknown> => {
  const p = node.props;
  const style = (p.jestAnimatedStyle as Animated)?.value;
  const props = (p.jestAnimatedProps as Animated)?.value;
  if (!has(style) && !has(props)) return p;
  return { ...p, ...props, ...(has(style) ? { style: [p.style, style] } : {}) };
};

// As the device walker reads it: a nested text inherits the `textTransform` around it unless it sets its own.
export const textOf = (node: ReactTestInstance): string => {
  const parts: string[] = [];
  const visit = (n: ReactTestInstance | string, transform: TextTransform | 'none' | undefined) => {
    if (typeof n === 'string') parts.push(transformText(n, transform, Platform.OS));
    else {
      const own = textTransformOf(liveProps(n)) ?? transform;
      for (const child of n.children) visit(child, own);
    }
  };
  visit(node, undefined);
  return parts.join('').replace(/\s+/g, ' ').trim();
};

// Stack and tab containers keep inactive screens mounted; the last child that
// is not an inactive RNSScreen is the one on top, as on a device.
export const topScreenChild = (container: ReactTestInstance): ReactTestInstance | null => {
  let top: ReactTestInstance | null = null;
  for (const child of container.children) {
    if (typeof child !== 'string' && (child.type !== 'RNSScreen' || child.props.activityState !== 0)) top = child;
  }
  return top;
};

// What React Native Testing Library 12 and 13 hand out: react-test-renderer's instances, composites included.
type RendererInstance = {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
  readonly parent: RendererInstance | null;
  readonly children: (RendererInstance | string)[];
  readonly _fiber?: Fiber;
  _currentFiber?: () => Fiber | null;
};

const originals = new WeakMap<object, RendererInstance>();

const isRendererInstance = (value: unknown): value is RendererInstance => typeof value === 'object' && value !== null && '_fiber' in value;

const hostChildren = (instance: RendererInstance): (RendererInstance | string)[] =>
  instance.children.flatMap((child) => (typeof child === 'string' || typeof child.type === 'string' ? [child] : hostChildren(child)));

const containers = new WeakMap<RendererInstance, ReactTestInstance>();

// The host-only view of a react-test-renderer tree, shaped as RNTL 14's: the backend walks hosts and strings, and a
// parent chain that ends at a typeless container. Read live on every access, since the tree under it changes.
const hostView = (root: RendererInstance): ReactTestInstance => {
  const cached = containers.get(root);
  if (cached) return cached;
  const wrappers = new WeakMap<RendererInstance, ReactTestInstance>();
  const wrap = (instance: RendererInstance): ReactTestInstance => {
    const known = wrappers.get(instance);
    if (known) return known;
    const node: ReactTestInstance = {
      get type() {
        return instance.type as string;
      },
      get props() {
        return instance.props;
      },
      get parent() {
        let up = instance.parent;
        while (up && typeof up.type !== 'string') up = up.parent;
        return up ? wrap(up) : container;
      },
      get children() {
        return hostChildren(instance).map((child) => (typeof child === 'string' ? child : wrap(child)));
      },
      get unstable_fiber() {
        // The instance keeps the fiber it was made from, which can be the stale alternate of the one on screen.
        return instance._currentFiber?.() ?? instance._fiber ?? null;
      },
    };
    wrappers.set(instance, node);
    originals.set(node, instance);
    return node;
  };
  const container: ReactTestInstance = {
    type: '',
    props: {},
    parent: null,
    get children() {
      return hostChildren(root).map((child) => (typeof child === 'string' ? child : wrap(child)));
    },
    unstable_fiber: null,
  };
  containers.set(root, container);
  return container;
};

/**
 * The rendered tree as hosts only, whichever Testing Library rendered it: 14 hands out such a tree as `container`;
 * 12 and 13 renamed `container` to `UNSAFE_root` (reading it throws) and hand out react-test-renderer's composite tree.
 */
export const hostRoot = (rendered: object): ReactTestInstance => {
  const r = rendered as { UNSAFE_root?: unknown; container?: unknown };
  if ('UNSAFE_root' in r && isRendererInstance(r.UNSAFE_root)) return hostView(r.UNSAFE_root);
  return isRendererInstance(r.container) ? hostView(r.container) : (r.container as ReactTestInstance);
};

/** What Testing Library's fireEvent expects for a node of `hostRoot`'s tree: it walks composites for handlers. */
export const rendererNode = (node: ReactTestInstance): object => originals.get(node) ?? node;
