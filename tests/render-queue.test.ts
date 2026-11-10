import { describe, it, expect, vi } from "vitest";
import { createPageRenderer } from "../src/ui/render-queue";
import { initialState, type AppState } from "../src/state/store";

function listState(): AppState {
  return {
    ...initialState(),
    sessionsLoaded: true,
    sessions: { items: [{ id: "a", title: "chat a", updated: 1 }], active: null },
  };
}

function sessionState(): AppState {
  return {
    ...initialState(),
    screen: "session",
    conn: "connected",
    sessions: { items: [{ id: "a", title: "chat a", updated: 1 }], active: "a" },
  };
}

type Call = string;

function makeDeps(opts?: { browsing?: boolean; stallList?: boolean }) {
  const calls: Call[] = [];
  let releaseList: (() => void) | undefined;
  const deps = {
    calls,
    showLoadingPage: vi.fn(async (content: string) => { calls.push(`loading:${content.split("\n")[0]}`); }),
    showListPage: vi.fn(async () => {
      calls.push("list");
      if (opts?.stallList) await new Promise<void>((res) => { releaseList = res; });
    }),
    showSessionPage: vi.fn(async () => { calls.push("session-page"); }),
    renderSession: vi.fn(async (s: AppState) => { calls.push(`session-render:${s.screen}`); }),
    isBrowsing: () => opts?.browsing ?? false,
    release: () => releaseList?.(),
  };
  return deps;
}

const flush = () => new Promise((res) => setTimeout(res, 0));

describe("createPageRenderer: boot resume race (F4)", () => {
  it("a list render still pending when the resume switches screens is dropped, not drawn", async () => {
    const deps = makeDeps();
    const pages = createPageRenderer(deps);

    // First sessions frame schedules the list build; the boot resume switches
    // to the session screen BEFORE the serializer runs anything.
    pages.render(listState());
    pages.render(sessionState());
    await flush();

    expect(deps.showListPage).not.toHaveBeenCalled();
    expect(deps.showSessionPage).toHaveBeenCalledOnce();
    expect(deps.renderSession).toHaveBeenCalledOnce();
    expect(deps.calls).toEqual(["session-page", "session-render:session"]);
  });

  it("a list build already in flight completes before the session page builds — never interleaved", async () => {
    const deps = makeDeps({ stallList: true });
    const pages = createPageRenderer(deps);

    pages.render(listState());
    await flush();
    expect(deps.calls).toEqual(["list"]); // in flight, holding the serializer

    pages.render(sessionState());
    await flush();
    expect(deps.calls).toEqual(["list"]); // waiting behind the list build

    deps.release();
    await flush();
    expect(deps.calls).toEqual(["list", "session-page", "session-render:session"]);
  });
});

describe("createPageRenderer: page-kind transitions and list guards", () => {
  it("rebuilds the list when returning from a session even if the rows are unchanged", async () => {
    const deps = makeDeps();
    const pages = createPageRenderer(deps);

    pages.render(listState());
    await flush();
    expect(deps.calls).toEqual(["list"]);

    pages.render(sessionState());
    await flush();
    expect(deps.calls).toEqual(["list", "session-page", "session-render:session"]);

    // Same list as before — but the glasses are on the session page.
    pages.render(listState());
    await flush();
    expect(deps.calls).toEqual(["list", "session-page", "session-render:session", "list"]);
  });

  it("skips identical list rebuilds while the list page is already built", async () => {
    const deps = makeDeps();
    const pages = createPageRenderer(deps);
    pages.render(listState());
    await flush();
    pages.render(listState()); // identical rows
    await flush();
    expect(deps.calls).toEqual(["list"]);
  });

  it("holds back changed rows while the wearer is mid-scroll, rebuilds otherwise", async () => {
    const deps = makeDeps({ browsing: true });
    const pages = createPageRenderer(deps);
    pages.render(listState());
    await flush();

    const refreshed = {
      ...listState(),
      sessions: { items: [{ id: "a", title: "renamed", updated: 9 }], active: null },
    };
    pages.render(refreshed);
    await flush();
    expect(deps.calls).toEqual(["list"]); // deferred: they are reading

    const awake = makeDeps({ browsing: false });
    const pages2 = createPageRenderer(awake);
    pages2.render(listState());
    await flush();
    pages2.render(refreshed);
    await flush();
    expect(awake.calls).toEqual(["list", "list"]);
  });

  it("snapshot() reports the rows actually drawn (tap resolution source)", async () => {
    const deps = makeDeps();
    const pages = createPageRenderer(deps);
    pages.render(listState());
    await flush();
    expect(pages.snapshot().ids).toEqual([null, "a"]);
  });

  it("renders the loading page until sessions hydrate", async () => {
    const deps = makeDeps();
    const pages = createPageRenderer(deps);
    pages.render(initialState());
    await flush();
    expect(deps.calls).toEqual(["loading:loading sessions..."]);
  });
});
