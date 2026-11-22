import test from "node:test";
import assert from "node:assert/strict";
import { checkReferenceBudget } from "../src/svg.ts";

class StubElement {
  nodeType = 1;
  localName: string;
  attributes: Array<{ name: string; value: string }> = [];
  childNodes: StubElement[] = [];
  private attrMap = new Map<string, string>();

  constructor(localName: string, attrs: Record<string, string> = {}, children: StubElement[] = []) {
    this.localName = localName;
    for (const [name, value] of Object.entries(attrs)) {
      this.attrMap.set(name, value);
      this.attributes.push({ name, value });
    }
    this.childNodes = children;
  }

  get id(): string {
    return this.attrMap.get("id") ?? "";
  }

  getAttribute(name: string): string | null {
    return this.attrMap.get(name) ?? null;
  }

  querySelectorAll(selector: string): StubElement[] {
    if (selector !== "[id]") return [];
    const found: StubElement[] = [];
    const walk = (node: StubElement) => {
      for (const child of node.childNodes) {
        if (child.id) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}

function withNodeGlobals(run: () => void) {
  const prev = (globalThis as Record<string, unknown>).Node;
  (globalThis as Record<string, unknown>).Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
  try {
    run();
  } finally {
    if (prev === undefined) delete (globalThis as Record<string, unknown>).Node;
    else (globalThis as Record<string, unknown>).Node = prev;
  }
}

test("checkReferenceBudget accepts ordinary url(#id) paint/mask references", () => {
  withNodeGlobals(() => {
    const svg = new StubElement("svg", { viewBox: "0 0 10 10" }, [
      new StubElement("linearGradient", { id: "g1" }, [new StubElement("stop", { offset: "0" })]),
      new StubElement("rect", { id: "r1", fill: "url(#g1)" }),
    ]);
    assert.doesNotThrow(() => checkReferenceBudget(svg as unknown as SVGSVGElement));
  });
});

test("checkReferenceBudget rejects cyclic url(#id) paint/clip/mask/marker references", () => {
  withNodeGlobals(() => {
    const a = new StubElement("g", { id: "a", fill: "url(#b)" });
    const b = new StubElement("mask", { id: "b", "clip-path": "url(#a)" });
    const svg = new StubElement("svg", { viewBox: "0 0 10 10" }, [a, b]);
    assert.throws(() => checkReferenceBudget(svg as unknown as SVGSVGElement), /Cyclic SVG references/);
  });
});

test("checkReferenceBudget rejects exponential acyclic url(#id) DAG reference bombs beyond 2 MiB", () => {
  withNodeGlobals(() => {
    const defsChildren: StubElement[] = [
      new StubElement("rect", { id: "leaf", width: "10", height: "10", fill: "red" }),
    ];
    // Fanout of 3 across 16 layers => 3^16 (> 43M) logical expansions
    for (let i = 1; i <= 16; i++) {
      const prev = i === 1 ? "leaf" : `n${i - 1}`;
      defsChildren.push(
        new StubElement("g", { id: `n${i}` }, [
          new StubElement("rect", { fill: `url(#${prev})`, stroke: `url(#${prev})`, mask: `url(#${prev})` }),
        ]),
      );
    }
    const svg = new StubElement("svg", { viewBox: "0 0 10 10" }, [
      new StubElement("defs", {}, defsChildren),
      new StubElement("rect", { fill: "url(#n16)" }),
    ]);
    assert.throws(() => checkReferenceBudget(svg as unknown as SVGSVGElement), /2 MiB/);
  });
});
