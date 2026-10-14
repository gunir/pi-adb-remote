import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Minimal stand-in for Pi's extension host, so the extension layer can be driven headlessly:
 * it records what the extension registered, lets a test call tools and commands exactly the way
 * the agent does, and exposes the replies the UI stubs will give.
 *
 * `cwd` is mutable because the extension reads it per call (it is the LOCAL working directory
 * that relative tool paths resolve against).
 */
export interface Harness {
  api: ExtensionAPI;
  tools: Map<string, any>;
  commands: Map<string, any>;
  events: Map<string, Array<(event: any, ctx: any) => any>>;
  cwd: string;
  entries: unknown[];
  ui: { confirm: boolean | Error; input: string | null | Error; custom: string | null | Error; selects: string[] };
  notifications: Array<{ text: string; level?: string }>;
  statuses: Array<Record<string, string | undefined>>;
  autocomplete: unknown[];
  makeCtx(overrides?: Record<string, unknown>): any;
  callTool(name: string, params: any, ctx?: any): Promise<any>;
  runCommand(name: string, args: string, ctx?: any): Promise<void>;
  fire(event: string, payload?: any, ctx?: any): Promise<any>;
}

export function createHarness(options: { cwd?: string } = {}): Harness {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const events = new Map<string, Array<(event: any, ctx: any) => any>>();
  const harness: Harness = {
    tools,
    commands,
    events,
    cwd: options.cwd ?? process.cwd(),
    entries: [],
    ui: { confirm: true, input: null, custom: null, selects: [] },
    notifications: [],
    statuses: [],
    autocomplete: [],
    api: undefined as unknown as ExtensionAPI,
    makeCtx,
    callTool: (name, params, ctx) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool "${name}" is not registered`);
      return tool.execute(`${name}-${tools.size}-${Math.random().toString(36).slice(2, 6)}`, params, undefined, () => {}, ctx ?? makeCtx());
    },
    runCommand: async (name, args, ctx) => {
      const command = commands.get(name);
      if (!command) throw new Error(`Command "/${name}" is not registered`);
      // Pi calls command handlers as (args, ctx), positionally.
      await command.handler(args, ctx ?? makeCtx());
    },
    fire: async (event, payload = {}, ctx) => {
      let last: unknown;
      for (const handler of events.get(event) ?? []) {
        const result = await handler(payload, ctx ?? makeCtx());
        if (result !== undefined) last = result;
      }
      return last;
    },
  };

  function makeCtx(overrides: Record<string, unknown> = {}): any {
    return {
      cwd: harness.cwd,
      mode: "rpc",
      hasUI: false,
      model: null,
      isProjectTrusted: () => true,
      thinkingLevel: "medium",
      sessionManager: { getBranch: () => harness.entries, getSessionId: () => "harness-session", getSessionFile: () => undefined },
      ui: {
        notify: (text: string, level?: string) => { harness.notifications.push({ text, level }); },
        setStatus: (key: string, text: string | undefined) => { harness.statuses.push({ [key]: text }); },
        setWorkingMessage: () => {},
        setHeader: () => {},
        confirm: async () => {
          if (harness.ui.confirm instanceof Error) throw harness.ui.confirm;
          return harness.ui.confirm as boolean;
        },
        input: async () => {
          if (harness.ui.input instanceof Error) throw harness.ui.input;
          return harness.ui.input;
        },
        select: async () => harness.ui.selects.shift() ?? null,
        editor: async () => null,
        custom: async () => {
          if (harness.ui.custom instanceof Error) throw harness.ui.custom;
          return harness.ui.custom;
        },
        addAutocompleteProvider: (provider: unknown) => { harness.autocomplete.push(provider); },
        theme: { fg: (_key: string, text: string) => text, bold: (text: string) => text },
      },
      ...overrides,
    };
  }

  const api = {
    registerTool: (tool: any) => { tools.set(tool.name, tool); },
    registerCommand: (name: string, options: any) => { commands.set(name, options); },
    on: (event: string, handler: (event: any, ctx: any) => any) => {
      const list = events.get(event) ?? [];
      list.push(handler);
      events.set(event, list);
    },
    appendEntry: () => {},
  };
  harness.api = api as unknown as ExtensionAPI;
  return harness;
}

/** Flatten a tool result into the text the model would see. */
export function text(result: any): string {
  return (result?.content ?? [])
    .map((block: any) => (block.type === "text" ? block.text : `[${block.type}${block.mimeType ? ` ${block.mimeType}` : ""}]`))
    .join("\n");
}
