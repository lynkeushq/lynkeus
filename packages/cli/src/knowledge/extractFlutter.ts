/**
 * The screen graph of a Flutter app, read from its Dart source with the same shape as the React Native one, so `map`,
 * `case impact`, `smoke` and `crawl` work unchanged on it.
 *
 * Routes come from go_router (`GoRoute`, nested `routes:`, shell routes, `TypedGoRoute`), from a Navigator's named
 * routes (`MaterialApp(routes:, home:)`, `onGenerateRoute` switching on the name) and, for routers of an app's own
 * (fluro and the like), from calls that register a path with a builder. A widget pushed without a name
 * (`Navigator.push(MaterialPageRoute(builder: (_) => X()))`) is a screen named after its class. What cannot be read is
 * a warning with its file and line, never a route silently missing.
 */
import fs from 'node:fs';
import path from 'node:path';

import { type Callee, type Code, calleeOf, type DartFile, type Member, type Range, splitEntry, splitItems } from './dart/library.js';
import { closureBody, DartProject, type Env, HOLE, isClosure, switchCases, topLevel } from './dart/project.js';
import type { FileFacts, NavigationEdge, NavigationTrigger, ScreenGraph, ScreenNode, Selector, SourcePath } from './types.js';

type Widget = { name: string; file: DartFile };

// Go somewhere by route name (go_router's and the Navigator's) or by location (a path, or a widget pushed as a route).
const BY_NAME = new Set([
  'goNamed',
  'pushNamed',
  'replaceNamed',
  'pushReplacementNamed',
  'popAndPushNamed',
  'pushNamedAndRemoveUntil',
  'restorablePushNamed',
  'restorablePushReplacementNamed',
  'restorablePopAndPushNamed',
  'restorablePushNamedAndRemoveUntil',
]);
const BY_LOCATION = new Set(['go', 'push', 'replace', 'pushReplacement', 'pushAndRemoveUntil', 'navigateTo', 'restorablePush']);
const NAVIGATION_RECEIVER = /navigator|context|router|^nav|currentState|routes?$/i;
const APPS = new Set(['MaterialApp', 'CupertinoApp', 'WidgetsApp']);
const WRAPPED = new Set(['child', 'body', 'page', 'screen']);
const CONTEXT_ARG = /^(context|ctx|this|_?context\w*|\w+\.context)$/;

export type FlutterExtractOptions = { root: string; sourceDir?: string };

export const pubspecName = (root: string): string => {
  try {
    return /^name:\s*['"]?([\w]+)/m.exec(fs.readFileSync(path.join(root, 'pubspec.yaml'), 'utf8'))?.[1] ?? path.basename(root);
  } catch {
    return path.basename(root);
  }
};

export const extractFlutterGraph = ({ root, sourceDir = 'lib' }: FlutterExtractOptions): ScreenGraph => {
  const name = pubspecName(root);
  return { ...readFlutterProject(DartProject.read(root, name, sourceDir)), app: name, root, extractedAt: new Date().toISOString() };
};

/** The graph of already-read sources: what `extractFlutterGraph` builds, and what tests feed fixtures to. */
export const readFlutterProject = (project: DartProject): Pick<ScreenGraph, 'screens' | 'files' | 'warnings'> => new Reader(project).read();

class Reader {
  private readonly screens: Record<string, ScreenNode> = {};
  private readonly warnings: string[] = [];
  /** go_router's full paths, for a `go('/habits/42')` to find the route called `habitDetail`. */
  private readonly paths = new Map<string, string>();
  private readonly typed = new Map<string, string>();

  constructor(private readonly project: DartProject) {}

  read(): Pick<ScreenGraph, 'screens' | 'files' | 'warnings'> {
    // The app's own entry first: a demo or a nested app elsewhere in lib/ must not claim its `/`.
    const files = [...this.project.files.values()].sort((a, b) => Number(b.rel === 'lib/main.dart') - Number(a.rel === 'lib/main.dart'));
    for (const file of files) this.readGoRouter(file);
    for (const file of files) this.readNavigatorApps(file);
    const registered = files.reduce((n, file) => n + this.readRegistrations(file), 0);
    if (registered) this.warnings.push(`${registered} route(s) read from calls that register a path with a builder (a router of the app's own)`);
    const facts: Record<SourcePath, FileFacts> = {};
    for (const file of files) facts[file.rel] = { selectors: this.selectors(file), navigates: this.edges(file), ...this.imports(file) };
    return { screens: this.screens, files: facts, warnings: this.warnings };
  }

  private warn(file: DartFile, at: number, message: string): void {
    this.warnings.push(`${file.rel}:${file.line(at)}: ${message}`);
  }

  private add(node: ScreenNode, file: DartFile, at: number, path?: string): void {
    const known = this.screens[node.route];
    if (known) {
      if (known.component !== node.component || known.file !== node.file)
        this.warn(file, at, `route "${node.route}" declared more than once; keeping the first (${known.declaredIn})`);
      return;
    }
    this.screens[node.route] = node;
    if (path) this.paths.set(path, node.route);
  }

  // go_router

  private readGoRouter(file: DartFile): void {
    file.tokens.forEach((tok, i) => {
      if (tok.text === 'GoRoute' && file.t(i + 1) === '(' && file.t(i - 1) !== 'class') this.readGoRoute(file, i + 1);
      if (tok.text === 'TypedGoRoute' && file.t(i + 1) === '<') {
        const open = file.skipAngles(i + 1);
        if (file.t(open) === '(') this.readGoRoute(file, open, file.t(i + 2));
      }
    });
  }

  private named(code: Code, open: number): Map<string, Range> {
    return new Map(
      splitItems(code, open)
        .filter((a) => a.name)
        .map((a) => [a.name!, { start: a.start, end: a.end }]),
    );
  }

  private readGoRoute(file: DartFile, open: number, typedClass?: string): void {
    const args = this.named(file, open);
    const pathArg = args.get('path');
    const nameArg = args.get('name');
    const literalPath = pathArg && pathArg.end - pathArg.start === 1 ? file.tokens[pathArg.start]?.parts : undefined;
    const relative = !!literalPath && !(literalPath[0] && 'text' in literalPath[0] && literalPath[0].text.startsWith('/'));
    const lexicalParent = this.enclosingRoute(file, open) >= 0;
    const close = file.match[open]!;
    const needs = (m: Member) => mentions(file, { start: open, end: close }, m) || (!lexicalParent && (relative || !literalPath));
    const at = open - 1;
    let read = 0;
    for (const env of this.contexts(file, open, needs, !lexicalParent && relative)) {
      const pathValue = pathArg ? this.project.evaluate(pathArg, env) : undefined;
      const own = pathValue?.kind === 'string' ? pathValue.text : undefined;
      const routeName = nameArg ? this.project.string(nameArg, env) : undefined;
      const parent = this.parentPath(file, open, env);
      const full = own === undefined ? undefined : joinPath(parent, own);
      const key = routeName ?? (full && !full.includes(HOLE) ? full : undefined);
      if (!key) continue;
      read++;
      if (own !== undefined && parent === undefined && !own.startsWith('/'))
        this.warn(file, at, `route "${key}": relative path "${own}" whose parent route was not found; read as "/${own}"`);
      const builder = args.get('builder') ?? args.get('pageBuilder');
      const redirect = args.get('redirect');
      if (!builder && !typedClass && redirect) {
        this.warn(file, at, `route "${key}" only redirects (${file.source(redirect, 60)}); not a screen`);
        continue;
      }
      const widget = typedClass ? this.typedWidget(typedClass, file) : builder ? this.widgetOf(builder, env) : undefined;
      if (!widget) this.warn(file, at, `route "${key}": ${builder ? `the builder (${file.source(builder, 60)})` : 'no builder'} names no widget of the app`);
      const params = full ? [...full.matchAll(/:(\w+)/g)].map((m) => m[1]!) : [];
      if (builder && needsExtra(file, builder)) params.push('extra');
      const location = full?.includes(HOLE) ? undefined : (full ?? undefined);
      this.add(
        {
          route: key,
          component: widget?.name ?? (typedClass || (builder ? described(file, builder) : '')),
          file: widget?.file.rel ?? null,
          declaredIn: file.rel,
          ...(params.length ? { params } : {}),
        },
        file,
        at,
        location?.startsWith('/') ? location : location ? `/${location}` : undefined,
      );
      if (typedClass) this.typed.set(typedClass, key);
    }
    if (read === 0) {
      const what = [pathArg ? `path ${file.source(pathArg, 60)}` : 'no path', nameArg ? `name ${file.source(nameArg, 60)}` : ''].filter(Boolean).join(', ');
      this.warn(file, at, `${typedClass ? 'TypedGoRoute' : 'GoRoute'} with ${what}: neither is a constant here or at its call sites; route not read`);
    }
  }

  /** The GoRoute (or TypedGoRoute) whose `routes:` holds token `at`, or -1. */
  private enclosingRoute(code: Code, at: number): number {
    for (let b = code.parent[at] ?? -1; b >= 0; b = code.parent[b] ?? -1) {
      if (code.tokens[b]!.text !== '(') continue;
      const callee = calleeOf(code, b);
      if (callee?.name !== 'GoRoute' && callee?.name !== 'TypedGoRoute') continue;
      const routes = splitItems(code, b).find((a) => a.name === 'routes');
      if (routes && routes.start <= at && at < routes.end) return b;
    }
    return -1;
  }

  /** The full path of the route that holds this one, walking out of helpers through the calls that entered them. */
  private parentPath(code: Code, at: number, env: Env): string | undefined {
    const parent = this.enclosingRoute(code, at);
    if (parent >= 0) {
      const p = splitItems(code, parent).find((a) => a.name === 'path');
      const own = p ? this.project.evaluate(p, env) : undefined;
      if (own?.kind !== 'string') return undefined;
      return joinPath(this.parentPath(code, parent, env), own.text);
    }
    if (env.callSite) return this.parentPath(env.callSite.code, env.callSite.at, env.callSite.env);
    return undefined;
  }

  /**
   * The contexts a route construct is read in: as written, or once per call of the helper that holds it, with that
   * call's arguments, when it reads the helper's parameters or needs the route the call sits in.
   */
  private contexts(file: DartFile, at: number, needs: (m: Member) => boolean, needParent: boolean, depth = 4): Env[] {
    const member = file.memberAt(at);
    const owner = member?.owner ?? file.classAt(at);
    const base: Env = { code: file, ...(owner ? { owner } : {}), depth: 0 };
    if (!member || depth === 0 || !needs(member)) return [base];
    const refs = this.project.references(member, file).filter((r) => r.open !== undefined || member.kind === 'field' || member.kind === 'getter');
    if (refs.length === 0 || refs.length > 80) return [base];
    const out: Env[] = [];
    for (const ref of refs) {
      const argsRange = ref.open === undefined ? { start: ref.at, end: ref.at + 1 } : { start: ref.open, end: (ref.file.match[ref.open] ?? ref.open) + 1 };
      const outerNeeds = (m: Member) => mentions(ref.file, argsRange, m) || (needParent && this.enclosingRoute(ref.file, ref.at) < 0);
      for (const outer of this.contexts(ref.file, ref.at, outerNeeds, needParent, depth - 1)) {
        out.push({
          ...base,
          ...(ref.open !== undefined && member.params ? { bindings: this.project.bind(member, ref.file, ref.open, outer) } : {}),
          callSite: { code: ref.file, at: ref.at, env: outer },
        });
        if (out.length >= 200) return out;
      }
    }
    return out.length ? out : [base];
  }

  private typedWidget(className: string, from: DartFile): Widget | undefined {
    const decl = this.project.classNamed(className, from);
    const build = decl?.item.members.find((m) => m.name === 'build' && m.body);
    return build ? this.findWidget(build.body!, this.project.envOf(build, decl!.file)) : undefined;
  }

  // Widgets

  /** The app's widget an expression builds: through a closure, a function, or a parameter bound at a call site. */
  private widgetOf(range: Range, env: Env, depth = 0, outermost = false): Widget | undefined {
    const value = this.project.evaluate(range, env);
    if (value.kind === 'code') return this.findWidget(closureBody(value.env.code, value.range) ?? value.range, value.env, depth, outermost);
    if (value.kind === 'function' && value.member.body) return this.findWidget(value.member.body, value.env, depth, outermost);
    return this.findWidget(range, env, depth, outermost);
  }

  /** The first widget of the app constructed in a range, in source order: the outermost one. */
  private findWidget(range: Range, env: Env, depth = 0, outermost = false): Widget | undefined {
    const { code } = env;
    for (let i = range.start; i < range.end; i++) {
      if (code.tokens[i]!.text !== '(') continue;
      const callee = calleeOf(code, i);
      if (!callee) continue;
      const cls = classOf(callee);
      if (cls) {
        if (!this.project.isWidget(cls, code.file)) continue;
        // A widget of the app that wraps another one in its `child:` (a pop scope, a provider) is not the screen.
        // A page pushed without a name keeps the outermost: the agent reports that page by the widget its route shows.
        const wrapped = outermost ? undefined : splitItems(code, i).find((a) => a.name && WRAPPED.has(a.name));
        const inner = wrapped && this.findWidget(wrapped, env, depth + 1);
        return inner ?? { name: cls, file: this.project.classNamed(cls, code.file)!.file };
      }
      if (depth >= 6 || callee.chain.length !== 1) continue;
      const bound = env.bindings?.get(callee.name);
      if (bound) {
        const found = this.widgetOf(bound.range, bound.env, depth + 1, outermost);
        if (found) return found;
        continue;
      }
      const fn = this.functionNamed(callee.name, env);
      if (fn?.member.body) {
        const inner = { ...this.project.envOf(fn.member, fn.file), bindings: this.project.bind(fn.member, code, i, env) };
        const found = this.findWidget(fn.member.body, inner, depth + 1, outermost);
        if (found) return found;
      }
    }
    return undefined;
  }

  private functionNamed(name: string, env: Env): { member: Member; file: DartFile } | undefined {
    const own = env.owner?.members.find((m) => m.name === name && m.kind === 'function');
    if (own) return { member: own, file: env.code.file };
    const top = this.project.topLevelNamed(name, env.code.file);
    return top?.item.kind === 'function' ? { member: top.item, file: top.file } : undefined;
  }

  // Navigator

  private readNavigatorApps(file: DartFile): void {
    file.tokens.forEach((tok, i) => {
      if (!APPS.has(tok.text) || file.t(i + 1) !== '(') return;
      const open = i + 1;
      const env: Env = { code: file, ...(file.classAt(open) ? { owner: file.classAt(open)! } : {}), depth: 0 };
      const args = this.named(file, open);
      const routes = args.get('routes');
      if (routes) this.readRouteMap(file, routes, env, i);
      const home = args.get('home');
      if (home && !this.screens['/']) {
        const widget = this.widgetOf(home, env);
        if (widget) this.add({ route: '/', component: widget.name, file: widget.file.rel, declaredIn: file.rel }, file, i, '/');
        else this.warn(file, i, `home: ${file.source(home, 60)} names no widget of the app`);
      }
      const generate = args.get('onGenerateRoute');
      if (generate) this.readGenerator(file, generate, env, i);
    });
  }

  private readRouteMap(file: DartFile, range: Range, env: Env, at: number): void {
    const value = this.project.evaluate(range, env);
    if (value.kind !== 'code' || value.env.code.tokens[value.range.start]?.text !== '{') {
      this.warn(file, at, `routes: ${file.source(range, 60)} is not a map of the app's; its routes are not read`);
      return;
    }
    const { code } = value.env;
    for (const item of splitItems(code, value.range.start)) {
      if (code.tokens[item.start]?.text === '...' || code.tokens[item.start]?.text === '?...') {
        this.readRouteMap(file, { start: item.start + 1, end: item.end }, value.env, at);
        continue;
      }
      const entry = splitEntry(code, item);
      if (!entry) continue;
      const route = this.project.string(entry.key, value.env);
      const where = code.file;
      if (route === undefined) {
        this.warn(where, entry.key.start, `routes: key ${where.source(entry.key, 60)} is not a constant; route not read`);
        continue;
      }
      const widget = this.widgetOf(entry.value, value.env);
      if (!widget) this.warn(where, entry.key.start, `route "${route}": ${where.source(entry.value, 60)} names no widget of the app`);
      this.add(
        {
          route,
          component: widget?.name ?? described(where, entry.value),
          file: widget?.file.rel ?? null,
          declaredIn: where.rel,
          ...(needsExtra(where, entry.value) ? { params: ['arguments'] } : {}),
        },
        where,
        entry.key.start,
        route.startsWith('/') ? route : undefined,
      );
    }
  }

  /** `onGenerateRoute`: the names it switches on (or compares in `if`s) and the widget each one builds. */
  private readGenerator(file: DartFile, range: Range, env: Env, at: number): void {
    const value = this.project.evaluate(range, env);
    const body =
      value.kind === 'code'
        ? { range: closureBody(value.env.code, value.range), env: value.env }
        : value.kind === 'function'
          ? { range: value.member.body, env: value.env }
          : undefined;
    if (!body?.range) {
      this.warn(file, at, `onGenerateRoute: ${file.source(range, 60)} is not a function of the app; the routes it makes are not read`);
      return;
    }
    const { code } = body.env;
    let found = 0;
    for (let i = body.range.start; i < body.range.end; i++) {
      const s = code.tokens[i]!.text;
      if (s === 'switch') {
        const cases = switchCases(code, i);
        if (!cases || !mentionsName(code, cases.subject)) continue;
        for (const c of cases.cases) {
          if (c.isDefault) continue;
          const widget = this.findWidget(c.body, body.env);
          for (const pattern of c.patterns) {
            const route = this.project.string(pattern, body.env);
            if (route === undefined) {
              this.warn(code.file, pattern.start, `onGenerateRoute: case ${code.file.source(pattern, 60)} is not a constant; route not read`);
              continue;
            }
            found++;
            this.addGenerated(route, widget, code.file, pattern.start);
          }
        }
      }
      if (s === 'if' && code.tokens[i + 1]?.text === '(') {
        const close = code.match[i + 1]!;
        const statement =
          code.tokens[close + 1]?.text === '{' ? { start: close + 1, end: code.match[close + 1]! + 1 } : { start: close + 1, end: endOf(code, close + 1) };
        for (const side of comparedNames(code, { start: i + 2, end: close })) {
          const route = this.project.string(side, body.env);
          if (route === undefined) continue;
          found++;
          this.addGenerated(route, this.findWidget(statement, body.env), code.file, side.start);
        }
      }
    }
    if (!found) this.warn(file, at, `onGenerateRoute: no switch or if on the route's name in ${file.source(range, 60)}; its routes are not read`);
  }

  private addGenerated(route: string, widget: Widget | undefined, file: DartFile, at: number): void {
    if (!widget) this.warn(file, at, `route "${route}": names no widget of the app`);
    this.add(
      { route, component: widget?.name ?? '', file: widget?.file.rel ?? null, declaredIn: file.rel },
      file,
      at,
      route.startsWith('/') ? route : undefined,
    );
  }

  /** `router.define('/goods', handler: Handler(handlerFunc: (_, __) => GoodsPage()))`: a path registered with a builder. */
  private readRegistrations(file: DartFile): number {
    let found = 0;
    file.tokens.forEach((tok, open) => {
      if (tok.text !== '(') return;
      const callee = calleeOf(file, open);
      if (!callee || callee.chain.length < 2 || !/^[a-z]/.test(callee.name) || BY_NAME.has(callee.name) || BY_LOCATION.has(callee.name)) return;
      const args = splitItems(file, open);
      const target = args.find((a) => !a.name && !CONTEXT_ARG.test(file.source(a)));
      if (!target) return;
      const rest = args.filter((a) => a !== target);
      if (!rest.some((a) => containsClosure(file, a))) return;
      const env: Env = { code: file, ...(file.classAt(open) ? { owner: file.classAt(open)! } : {}), depth: 0 };
      const route = this.project.string(target, env);
      if (!route?.startsWith('/') || this.screens[route]) return;
      const widget = rest.map((a) => this.findWidget(a, env)).find(Boolean);
      if (!widget) return;
      found++;
      this.add({ route, component: widget.name, file: widget.file.rel, declaredIn: file.rel }, file, callee.nameAt, route);
    });
    return found;
  }

  // Edges, selectors, imports

  private edges(file: DartFile): NavigationEdge[] {
    const handlers = this.handlers(file);
    const edges: NavigationEdge[] = [];
    file.tokens.forEach((tok, open) => {
      if (tok.text !== '(') return;
      const callee = calleeOf(file, open);
      if (!callee) return;
      const edge = this.edgeOf(file, open, callee);
      if (!edge) return;
      const direct = this.ownerTrigger(file, open);
      const member = file.memberAt(open);
      const viaHandler = !direct && member ? handlers.get(member.name) : undefined;
      edges.push({
        ...edge,
        line: file.line(callee.nameAt),
        via: direct ?? viaHandler ?? { kind: 'unknown' },
        ...(direct ? { linkage: 'element' as const } : viaHandler ? { linkage: 'handler' as const } : {}),
      });
    });
    return edges;
  }

  private edgeOf(file: DartFile, open: number, callee: Callee): Pick<NavigationEdge, 'to' | 'confidence'> | undefined {
    const typedClass = callee.chain.length >= 2 ? /^([A-Z]\w*)\(\)$/.exec(callee.chain.at(-2)!)?.[1] : undefined;
    if (typedClass && BY_LOCATION.has(callee.name)) {
      const key = this.typed.get(typedClass);
      if (key) return { to: key, confidence: 'static' };
    }
    const receiver = callee.chain.slice(0, -1).join('.');
    // A helper of the app's own (`pushRouteUp`, `goWebViewPage`) counts only when it leads to a known route or a widget.
    const known = BY_NAME.has(callee.name) || BY_LOCATION.has(callee.name);
    const generic = !known && /^(push|go|navigate)[A-Z]/.test(callee.name) && !/back|pop/i.test(callee.name);
    if (!receiver || !NAVIGATION_RECEIVER.test(receiver)) return undefined;
    if (!known && !generic) return undefined;
    const target = splitItems(file, open).find((a) => !a.name && !CONTEXT_ARG.test(file.source(a)));
    if (!target) return undefined;
    const env: Env = { code: file, ...(file.classAt(open) ? { owner: file.classAt(open)! } : {}), depth: 0 };
    const value = this.project.evaluate(target, env);
    if (value.kind === 'string') {
      const key = this.resolve(value.text, BY_NAME.has(callee.name));
      if (key) return { to: key, confidence: 'static' };
      if (generic) return undefined;
      if (value.exact) return { to: value.text, confidence: 'static' };
      return { to: file.source(target), confidence: 'dynamic' };
    }
    const settingsName = this.routeSettingsName(file, target, env);
    const widget = this.findWidget(target, env, 0, !settingsName);
    if (settingsName) {
      if (widget) this.add({ route: settingsName, component: widget.name, file: widget.file.rel, declaredIn: file.rel }, file, callee.nameAt);
      return { to: settingsName, confidence: 'static' };
    }
    if (widget) {
      if (!this.screens[widget.name])
        this.screens[widget.name] = { route: widget.name, component: widget.name, file: widget.file.rel, declaredIn: file.rel, unnamed: true };
      return { to: widget.name, confidence: 'static' };
    }
    return generic ? undefined : { to: file.source(target), confidence: 'dynamic' };
  }

  /** `MaterialPageRoute(builder: …, settings: RouteSettings(name: '/x'))`: pushed with a name after all. */
  private routeSettingsName(file: DartFile, range: Range, env: Env): string | undefined {
    for (let i = range.start; i < range.end; i++) {
      if (file.t(i) !== 'RouteSettings' || file.t(i + 1) !== '(') continue;
      const name = splitItems(file, i + 1).find((a) => a.name === 'name');
      return name ? this.project.string(name, env) : undefined;
    }
    return undefined;
  }

  /** A route key for a name or a location: the key itself, the path without its query, or the go_router pattern it fits. */
  private resolve(text: string, byName: boolean): string | undefined {
    if (!text.includes(HOLE) && this.screens[text]) return text;
    if (byName) return undefined;
    const location = text.split(/[?#]/)[0]!;
    if (!location.includes(HOLE) && this.screens[location]) return location;
    const known = this.paths.get(location);
    if (known) return known;
    const segments = location.split('/');
    const fits = [...this.paths.entries()]
      .filter(([pattern]) => {
        const parts = pattern.split('/');
        return parts.length === segments.length && parts.every((p, k) => (p.startsWith(':') ? segments[k] !== '' : p === segments[k]));
      })
      .sort(([a], [b]) => (a.match(/:/g)?.length ?? 0) - (b.match(/:/g)?.length ?? 0));
    return fits[0]?.[1];
  }

  /** The test id of the widget whose `on…:` callback holds token `at`: its `key: ValueKey('…')`. */
  private ownerTrigger(code: Code, at: number): NavigationTrigger | undefined {
    for (let b = code.parent[at] ?? -1; b >= 0; b = code.parent[b] ?? -1) {
      if (code.tokens[b]!.text !== '(') continue;
      const callee = calleeOf(code, b);
      if (!callee || !classOf(callee)) continue;
      const items = splitItems(code, b);
      const holder = items.find((a) => a.start <= at && at < a.end);
      if (!holder?.name || !/^on[A-Z]/.test(holder.name)) continue;
      return (
        keyTrigger(
          code,
          items.find((a) => a.name === 'key'),
        ) ?? undefined
      );
    }
    return undefined;
  }

  /** `onPressed: _openList` on a widget keyed `open-list`: the handler's name to that key, once per file. */
  private handlers(file: DartFile): Map<string, NavigationTrigger> {
    const out = new Map<string, NavigationTrigger>();
    file.tokens.forEach((tok, open) => {
      if (tok.text !== '(') return;
      const callee = calleeOf(file, open);
      if (!callee || !classOf(callee)) return;
      const items = splitItems(file, open);
      const trigger = keyTrigger(
        file,
        items.find((a) => a.name === 'key'),
      );
      if (!trigger) return;
      for (const item of items) {
        if (!item.name || !/^on[A-Z]/.test(item.name)) continue;
        const handler = handlerName(file, item);
        if (handler) out.set(handler, trigger);
      }
    });
    return out;
  }

  private selectors(file: DartFile): Selector[] {
    const out: Selector[] = [];
    file.tokens.forEach((tok, i) => {
      if ((tok.text === 'ValueKey' || tok.text === 'Key') && file.t(i - 1) !== '.') {
        const open = file.t(i + 1) === '<' ? file.skipAngles(i + 1) : i + 1;
        if (file.t(open) !== '(') return;
        const first = splitItems(file, open)[0];
        const id = first && first.end - first.start === 1 ? literal(file, first.start) : undefined;
        if (id !== undefined) out.push({ id, line: tok.line });
      }
      if (tok.text === 'Semantics' && file.t(i + 1) === '(') {
        const identifier = splitItems(file, i + 1).find((a) => a.name === 'identifier');
        const id = identifier && identifier.end - identifier.start === 1 ? literal(file, identifier.start) : undefined;
        if (id !== undefined) out.push({ id, line: file.line(identifier!.start) });
      }
    });
    return out;
  }

  private readonly exportCache = new Map<DartFile, Map<string, DartFile>>();

  /** Every name a file makes available to an importer, with the file that declares it, through its exports. */
  private exported(file: DartFile, seen = new Set<DartFile>()): Map<string, DartFile> {
    const known = this.exportCache.get(file);
    if (known) return known;
    const out = new Map<string, DartFile>();
    if (seen.has(file)) return out;
    seen.add(file);
    for (const name of file.declared) out.set(name, file);
    for (const d of file.directives) {
      if (d.kind !== 'export') continue;
      for (const uri of d.uris) {
        const target = this.project.resolveUri(file, uri);
        if (!target) continue;
        for (const [name, where] of this.exported(target, seen)) if (!d.show || d.show.includes(name)) if (!out.has(name)) out.set(name, where);
      }
    }
    this.exportCache.set(file, out);
    return out;
  }

  /**
   * Import edges. Importing a barrel (a file that exports others) points at the files that declare the names this
   * file uses, not at the barrel: otherwise a change to one widget reaches every screen that imports the barrel.
   */
  private imports(file: DartFile): { imports: SourcePath[]; barrels: SourcePath[] } {
    const imports = new Set<SourcePath>();
    const barrels = new Set<SourcePath>();
    let used: Set<string> | undefined;
    for (const d of file.directives) {
      for (const uri of d.uris) {
        const target = this.project.resolveUri(file, uri);
        if (!target || target === file) continue;
        const isBarrel = d.kind === 'import' && target.directives.some((x) => x.kind === 'export');
        if (!isBarrel) {
          imports.add(target.rel);
          continue;
        }
        used ??= new Set(file.tokens.filter((t) => t.kind === 'ident').map((t) => t.text));
        const names = d.show ?? [...used];
        const declaring = new Set<DartFile>();
        const offered = this.exported(target);
        for (const name of names) {
          const where = offered.get(name);
          if (where) declaring.add(where);
        }
        if (declaring.size === 0 || declaring.has(target)) imports.add(target.rel);
        for (const where of declaring) if (where !== target) imports.add(where.rel);
        if (declaring.size && !declaring.has(target)) barrels.add(target.rel);
      }
    }
    return { imports: [...imports], barrels: [...barrels].filter((b) => !imports.has(b)) };
  }
}

const joinPath = (parent: string | undefined, own: string): string => {
  if (own.startsWith('/') || parent === undefined) return own;
  if (parent === '' || parent.endsWith('/')) return `${parent}${own}`;
  return own ? `${parent}/${own}` : parent;
};

/** What a builder that names no widget says: its closure's body, or the expression. */
const described = (file: DartFile, range: Range): string => file.source(closureBody(file, range) ?? range, 60);

const literal = (code: Code, at: number): string | undefined => {
  const tok = code.tokens[at];
  if (tok?.kind !== 'string' || tok.parts?.some((p) => 'expr' in p)) return undefined;
  return (tok.parts ?? []).map((p) => ('text' in p ? p.text : '')).join('');
};

/** The class a call constructs: `Foo(`, `const Foo<T>(`, `Foo.named(`, `prefix.Foo(`. */
const classOf = (callee: Callee): string | undefined => {
  const names = callee.chain.filter((c) => !c.endsWith('()'));
  if (names.length !== callee.chain.length) return undefined;
  if (/^_?[A-Z]/.test(callee.name)) return callee.name;
  const before = names.at(-2);
  return before && /^_?[A-Z]/.test(before) && names.length <= 3 ? before : undefined;
};

/** Whether a range names one of a member's parameters (or `this`, for an enum's own getter). */
const mentions = (code: Code, range: Range, member: Member): boolean => {
  const names = new Set((member.params ?? []).map((p) => p.name));
  if (names.size === 0) return false;
  for (let i = range.start; i < range.end; i++) {
    const tok = code.tokens[i]!;
    if (tok.kind === 'ident' && names.has(tok.text) && code.tokens[i - 1]?.text !== '.') return true;
    if (tok.kind === 'string' && tok.parts?.some((p) => 'expr' in p && [...names].some((n) => new RegExp(`\\b${n}\\b`).test(p.expr)))) return true;
  }
  return false;
};

const mentionsName = (code: Code, range: Range): boolean => {
  for (let i = range.start; i < range.end; i++) if (['name', 'path'].includes(code.tokens[i]!.text)) return true;
  return false;
};

/** In `settings.name == '/x' || '/y' == name`, the sides compared with the name. */
const comparedNames = (code: Code, range: Range): Range[] => {
  const out: Range[] = [];
  const bars = topLevel(code, range.start, range.end, ['||']);
  const starts = [range.start, ...bars.map((b) => b + 1)];
  const ends = [...bars, range.end];
  starts.forEach((s, k) => {
    const e = ends[k]!;
    const eq = topLevel(code, s, e, ['=='])[0];
    if (eq === undefined) return;
    const left = { start: s, end: eq };
    const right = { start: eq + 1, end: e };
    if (mentionsName(code, left)) out.push(right);
    else if (mentionsName(code, right)) out.push(left);
  });
  return out;
};

const endOf = (code: Code, i: number): number => {
  let j = i;
  for (; j < code.tokens.length && code.tokens[j]!.text !== ';'; j++) {
    const s = code.tokens[j]!.text;
    if (s === '(' || s === '[' || s === '{') j = Math.max(j, code.match[j] ?? j);
  }
  return j + 1;
};

const containsClosure = (code: Code, range: Range): boolean => {
  for (let i = range.start; i < range.end; i++) if (isClosure(code, i)) return true;
  return false;
};

/** A builder that casts `state.extra` (or the route's `arguments`) to a type that is not nullable needs them. */
const needsExtra = (file: DartFile, range: Range): boolean => {
  const text = file.source(range, 100_000);
  return /\b(extra|arguments)\s*(as\s+[\w<>, ]+[^?\w<>, ]|!)/.test(`${text} `);
};

/** `key: const ValueKey('send')` as a trigger; one built at runtime as a dynamic one. */
const keyTrigger = (code: Code, key: { start: number; end: number } | undefined): NavigationTrigger | undefined => {
  if (!key) return undefined;
  let i = key.start;
  while (code.tokens[i]?.text === 'const') i++;
  const name = code.tokens[i]?.text;
  if (name !== 'ValueKey' && name !== 'Key') return undefined;
  let open = i + 1;
  if (code.tokens[open]?.text === '<') while (open < key.end && code.tokens[open]?.text !== '(') open++;
  const first = splitItems(code, open)[0];
  if (!first) return undefined;
  const id = first.end - first.start === 1 ? literal(code, first.start) : undefined;
  if (id !== undefined) return { kind: 'testId', testId: id };
  return { kind: 'dynamicTestId', expression: code.file.source(first, 80) };
};

/** `onTap: _go`, `onTap: () => _go(context)`, `onTap: () { _go(); }`: the function a callback hands over to. */
const handlerName = (code: Code, item: Range): string | undefined => {
  const t = (i: number) => code.tokens[i]?.text ?? '';
  if (item.end - item.start === 1 && code.tokens[item.start]?.kind === 'ident') return t(item.start);
  if (item.end - item.start === 3 && ['widget', 'this'].includes(t(item.start)) && t(item.start + 1) === '.') return t(item.start + 2);
  const body = closureBody(code, item);
  if (!body) return undefined;
  let s = body.start;
  if (t(s) === '{') s++;
  while (t(s) === 'await') s++;
  return code.tokens[s]?.kind === 'ident' && t(s + 1) === '(' ? t(s) : undefined;
};
