import type { AppState } from "../state/store";
import { serializeLatest } from "../util/coalesce";
import { buildListView, loadingText, renderSession, type ListView } from "./views";
import { showListPage, showLoadingPage, showSessionPage } from "./render";
import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";

/**
 * The ONE path that writes pages to the glasses. Page-kind transitions
 * (loading ↔ list ↔ session) happen inside the serialized render so a build
 * can never be interleaved with — or undone by — a build scheduled next to it
 * (the boot-resume race: list build queued, resume switches to the session
 * screen, latest-wins drops the stale list build instead of drawing it).
 */
export interface PageRendererDeps {
  showLoadingPage(content: string): Promise<void>;
  showListPage(rows: string[]): Promise<void>;
  showSessionPage(): Promise<void>;
  renderSession(s: AppState): Promise<void>;
  /** True while the wearer is mid-scroll on the list (rebuilds are held back). */
  isBrowsing(): boolean;
}

export function pageRendererDeps(bridge: EvenAppBridge, isBrowsing: () => boolean): PageRendererDeps {
  return {
    showLoadingPage: (content) => showLoadingPage(bridge, content),
    showListPage: (rows) => showListPage(bridge, rows),
    showSessionPage: () => showSessionPage(bridge),
    renderSession: (s) => renderSession(bridge, s),
    isBrowsing,
  };
}

export function createPageRenderer(deps: PageRendererDeps) {
  /** Which page kind is currently built on the glasses. */
  let builtPage: "loading" | "list" | "session" = "loading";
  /** The list snapshot actually drawn — a tap resolves against this. */
  let shown: ListView = { rows: [], ids: [] };

  const render = serializeLatest(async (s: AppState) => {
    if (s.screen === "list") {
      if (!s.sessionsLoaded) {
        await deps.showLoadingPage(loadingText(s));
        builtPage = "loading";
        return;
      }
      const next = buildListView(s);
      // A list cannot be updated in place, so every render is a full rebuild —
      // and a rebuild throws away the native scroll position and selection.
      // Two guards, because `sessions` frames arrive on their own schedule and
      // would otherwise yank the wearer back to the top mid-scroll:
      //   1. identical rows → nothing to show, skip
      //   2. scrolled in the last few seconds → they are reading, defer
      // Rows alone are not identity: two same-titled sessions in one age
      // bucket differ only in ids. Both guards only apply while the list page
      // itself is on the glasses — coming back from a session must redraw it.
      const unchanged =
        next.rows.length === shown.rows.length
        && next.rows.every((r, i) => r === shown.rows[i])
        && next.ids.length === shown.ids.length
        && next.ids.every((id, i) => id === shown.ids[i]);
      if (builtPage === "list" && (unchanged || deps.isBrowsing())) return;
      shown = next;
      await deps.showListPage(next.rows);
      builtPage = "list";
      return;
    }
    if (builtPage !== "session") {
      await deps.showSessionPage();
      builtPage = "session";
    }
    await deps.renderSession(s);
  });

  return {
    render,
    snapshot: (): ListView => shown,
  };
}
