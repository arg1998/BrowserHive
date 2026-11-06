/** @module offline/dom — tiny DOM builders for the offline page: `createElement` and `textContent` only, never `innerHTML` (04 §18.6) */

/** A child: an element, or text set through a text node. */
export type Child = Node | string | null | undefined | false;

/** Attributes and the class list of a new element. */
export interface ElementProps {
  readonly className?: string;
  readonly attrs?: Readonly<Record<string, string>>;
}

/** Creates `<tag>` in `doc` with its class, attributes and children. */
export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  props: ElementProps = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (props.className !== undefined) node.className = props.className;
  for (const [name, value] of Object.entries(props.attrs ?? {})) node.setAttribute(name, value);
  append(doc, node, children);
  return node;
}

/** Appends children (strings become text nodes). */
export function append(doc: Document, parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' ? doc.createTextNode(child) : child);
  }
}

/** Replaces every child of `parent`. */
export function replaceChildren(doc: Document, parent: Node, children: readonly Child[]): void {
  while (parent.firstChild !== null) parent.removeChild(parent.firstChild);
  append(doc, parent, children);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An SVG element (`createElementNS`). */
export function svg(
  doc: Document,
  tag: string,
  attrs: Readonly<Record<string, string>>,
  children: readonly Element[] = [],
): SVGElement {
  const node = doc.createElementNS(SVG_NS, tag) as SVGElement;
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  for (const child of children) node.appendChild(child);
  return node;
}
