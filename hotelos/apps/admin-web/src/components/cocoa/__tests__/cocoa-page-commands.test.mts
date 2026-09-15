import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  PAGE_COMMANDS_EVENT,
  commandsKey,
  getPageCommands,
  registerPageCommands,
  resetPageCommands,
  resolvePageState,
  subscribePageCommands
} from "../cocoa-page-commands.ts";

const noop = () => undefined;

describe("cocoa-page-commands · registry", () => {
  beforeEach(() => resetPageCommands());

  it("starts empty and exposes registered commands", () => {
    assert.deepEqual(getPageCommands(), []);
    const off = registerPageCommands([{ id: "refresh", label: "Actualizar", run: noop }]);
    assert.deepEqual(getPageCommands().map((c) => c.id), ["refresh"]);
    off();
    assert.deepEqual(getPageCommands(), []);
  });

  it("later registrations (deeper pages) win on id collisions and come first", () => {
    const outerRun = () => "outer";
    const innerRun = () => "inner";
    registerPageCommands([{ id: "new", label: "Nueva reserva", run: outerRun }, { id: "refresh", label: "Actualizar", run: noop }]);
    registerPageCommands([{ id: "new", label: "Nuevo grupo", run: innerRun }]);
    const commands = getPageCommands();
    assert.deepEqual(commands.map((c) => c.id), ["new", "refresh"]);
    assert.equal(commands[0].label, "Nuevo grupo");
    assert.equal(commands[0].run, innerRun);
  });

  it("notifies subscribers on every change and stops after unsubscribe", () => {
    const seen: number[] = [];
    const unsubscribe = subscribePageCommands((commands) => seen.push(commands.length));
    const off = registerPageCommands([{ id: "a", label: "A", run: noop }]);
    off();
    unsubscribe();
    registerPageCommands([{ id: "b", label: "B", run: noop }]);
    assert.deepEqual(seen, [1, 0]);
  });

  it("unregistering twice is harmless", () => {
    const off = registerPageCommands([{ id: "a", label: "A", run: noop }]);
    off();
    off();
    assert.deepEqual(getPageCommands(), []);
  });

  it("names the window event", () => {
    assert.equal(PAGE_COMMANDS_EVENT, "cocoa-page-commands");
  });
});

describe("cocoa-page-commands · commandsKey", () => {
  it("is stable across `run` closures and changes with id/label/shortcut", () => {
    const a = commandsKey([{ id: "x", label: "X", run: () => 1 }]);
    const b = commandsKey([{ id: "x", label: "X", run: () => 2 }]);
    assert.equal(a, b);
    assert.notEqual(a, commandsKey([{ id: "x", label: "Y", run: noop }]));
    assert.notEqual(a, commandsKey([{ id: "x", label: "X", shortcut: "⌘R", run: noop }]));
    assert.equal(commandsKey(undefined), "");
    assert.equal(commandsKey([]), "");
  });
});

describe("cocoa-page-commands · resolvePageState", () => {
  it("prefers the explicit state, then loading → error → empty → ready", () => {
    assert.equal(resolvePageState({ state: "empty", loading: true }), "empty");
    assert.equal(resolvePageState({ loading: true, error: "x" }), "loading");
    assert.equal(resolvePageState({ error: new Error("x"), empty: true }), "error");
    assert.equal(resolvePageState({ empty: true }), "empty");
    assert.equal(resolvePageState({}), "ready");
    assert.equal(resolvePageState({ error: null, loading: false }), "ready");
  });
});
