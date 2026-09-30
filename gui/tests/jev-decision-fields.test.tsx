import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { jevAutoCreateHash } from "../src/app-routing";
import ComboWorkspace from "../src/components/ComboWorkspace";
import ProviderDetails from "../src/components/provider-workspace/ProviderDetails";
import { navigateHash } from "../src/hash-routing";
import { LanguageProvider } from "../src/i18n/provider";
import Combos from "../src/pages/Combos";
import type { ComboItem } from "../src/combo-workspace-data";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let originalFetch: typeof globalThis.fetch;
let testWindow: Window;
let root: Root | null;

const models = [
  { provider: "openai", id: "gpt-6-astra", reasoningEfforts: ["medium", "high"] },
  { provider: "openai", id: "gpt-5.6-sol", reasoningEfforts: ["low", "medium"] },
  { provider: "openai", id: "gpt-5.6-luna", reasoningEfforts: ["low"] },
];
const providers = [
  { name: "openai", adapter: "openai-responses" },
  { name: "jev", adapter: "jev-decision", baseUrl: "https://api.typesafe.ai/v1/systemone", hiddenFromPicker: true },
  { name: "tev-local", adapter: "jev-decision", baseUrl: "http://127.0.0.1:11434/v1/systemone", hiddenFromPicker: true },
];

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  originalFetch = globalThis.fetch;
  testWindow = new Window({ url: "http://localhost/#providers/tev-local" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = null;
});

afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function flush(rounds = 3) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  });
}

function setSelect(select: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(testWindow.HTMLSelectElement.prototype, "value")!
    .set!.call(select, value);
  select.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
}

function setInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!
    .set!.call(input, value);
  input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
}

function button(host: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find(candidate => candidate.textContent?.trim() === text);
}

test("a keyless self-hosted decision row creates JEV Auto with itself as the decision service", async () => {
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);

  await act(async () => {
    root!.render(
      <LanguageProvider>
        <ProviderDetails
          item={{
            name: "tev-local",
            adapter: "jev-decision",
            baseUrl: "http://127.0.0.1:11434/v1/systemone",
            authMode: "key",
            hasApiKey: false,
          }}
          availableModels={[]}
          hasLiveModels={false}
          selectedModels={[]}
          modelRows={[]}
          modelRevision="tev-test"
          modelRowsReady
          onOpenModels={() => {}}
          onCreateJevAuto={() => navigateHash(jevAutoCreateHash("tev-local"))}
          onDeselect={() => {}}
          apiBase=""
        />
      </LanguageProvider>,
    );
  });
  const providerAction = button(host, "Create JEV Auto");
  expect(providerAction).toBeDefined();
  await act(async () => { providerAction!.click(); });
  expect(window.location.hash).toBe("#models/combos/jev-auto?decisionProvider=tev-local");

  await act(async () => { root!.unmount(); });
  root = createRoot(host);

  const puts: Array<{ combo: Record<string, unknown> }> = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/combos") && init?.method === "PUT") {
        puts.push(JSON.parse(String(init.body)));
        return Response.json({ success: true });
      }
      if (url.endsWith("/api/combos")) return Response.json({ combos: [] });
      if (url.endsWith("/api/config")) {
        return Response.json({
          providers: Object.fromEntries(providers.map(({ name, adapter, baseUrl }) => [name, { adapter, baseUrl: baseUrl ?? "" }])),
        });
      }
      if (url.endsWith("/api/models")) return Response.json(models);
      if (url.endsWith("/api/provider-quotas")) return Response.json({ reports: [] });
      throw new Error(`unexpected request: ${url}`);
    },
  });

  await act(async () => {
    root!.render(<LanguageProvider><Combos apiBase="" /></LanguageProvider>);
  });
  await flush(6);

  const dialog = host.querySelector<HTMLDialogElement>('dialog[data-combo-preset="jev-auto"]');
  expect(dialog).not.toBeNull();
  const service = host.querySelector<HTMLSelectElement>("#cwi-new-decision-provider")!;
  expect(service.value).toBe("tev-local");
  expect([...service.options].map(option => [option.value, option.textContent])).toEqual([
    ["", "TypeSafe JEV (default)"],
    ["tev-local", "tev-local"],
  ]);
  expect(dialog!.textContent).toContain("http://127.0.0.1:11434/v1/systemone");
  const timeout = host.querySelector<HTMLInputElement>("#cwi-new-decision-timeout")!;
  expect(timeout.placeholder).toBe("4000");
  await act(async () => { setInput(timeout, "60000"); });

  await act(async () => { button(host, "Create combo")!.click(); });
  await flush();

  expect(puts).toHaveLength(1);
  expect(puts[0]!.combo).toMatchObject({ strategy: "jev", decisionProvider: "tev-local", decisionTimeoutMs: 60000 });
});

test("the overview names each JEV combo's service; the editor clears it and hides it off JEV", async () => {
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const combo: ComboItem = {
    id: "tev-auto",
    model: "combo/tev-auto",
    alias: null,
    nativeAlias: false,
    displayName: null,
    strategy: "jev",
    stickyLimit: 1,
    defaultEffort: null,
    decisionProvider: "tev-local",
    decisionTimeoutMs: 30000,
    targets: [{ provider: "openai", model: "gpt-6-astra", clientKey: "t1" }],
  };
  const saved: ComboItem[] = [];

  await act(async () => {
    root!.render(
      <LanguageProvider>
        <ComboWorkspace
          combos={[combo]}
          providerQuotaStates={{}}
          providers={providers}
          models={models}
          loading={false}
          onRefresh={() => {}}
          onSave={async (item) => { saved.push(item); return { ok: true }; }}
          onRemove={async () => ({ ok: true })}
          onAdd={() => {}}
          adding={false}
          onCloseAdd={() => {}}
          onCreated={() => {}}
        />
      </LanguageProvider>,
    );
  });

  const row = host.querySelector<HTMLButtonElement>('[data-decision-provider="tev-local"]');
  expect(row?.textContent).toContain("tev-local");
  expect(row?.textContent).toContain("http://127.0.0.1:11434/v1/systemone");
  expect(row?.textContent).toContain("Timeout 30000 ms");
  await act(async () => { row!.click(); });
  await flush(); // the detail panel syncs its draft from the baseline on a zero-delay timer

  const service = host.querySelector<HTMLSelectElement>("#cwi-edit-decision-provider")!;
  expect(service.value).toBe("tev-local");
  expect(host.querySelector<HTMLInputElement>("#cwi-edit-decision-timeout")!.value).toBe("30000");

  await act(async () => { setSelect(service, ""); });
  expect(service.value).toBe("");
  await act(async () => { setInput(host.querySelector<HTMLInputElement>("#cwi-edit-decision-timeout")!, ""); });
  expect(host.textContent).toContain("The hosted TypeSafe decision service");
  await act(async () => { host.querySelector<HTMLButtonElement>("#cwi-edit-save")!.click(); });
  await flush();
  expect(saved.at(-1)).toMatchObject({ decisionProvider: null, decisionTimeoutMs: null });

  const failover = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    .find(candidate => candidate.textContent?.trim() === "Failover")!;
  await act(async () => { failover.click(); });
  expect(host.querySelector("#cwi-edit-decision-provider")).toBeNull();
  expect(host.querySelector("#cwi-edit-decision-timeout")).toBeNull();
});
