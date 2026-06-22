# World Engine UI Rework — All Repos

> **For Hermes:** Use CC (Opus) to implement each repo's changes.

**Goal:** Fix the world engine UI across all 8 ecosystem repos that use it.

**Architecture:** The world engine is a shared pattern (index.html + app.js + scenes.js + CSS) that renders a Pehverse shell with scenes, hotspots, workspaces, and a dashboard. Each repo customizes the scenes/workspaces for its product.

**Repos affected:**
1. ikbi — The Workshop (build engine)
2. pehlichi — The Settlement (coordinator)
3. pehlichi-pub — Public teaching edition
4. nusika — Adaptive learning
5. toba — Career transformation
6. howa — Agent proving ground
7. kokuli — Adversarial testing
8. luak — Scoreboard/evidence

---

## Universal Fixes (apply to ALL 8 repos)

### Fix 1: Disable workspace auto-open
**Problem:** Dashboard mode auto-opens ALL workspaces at once, flooding the screen.
**Fix:** Make `pehAutoOpenDashboard()` a no-op. Users open workspaces via hotspots or fast travel.

### Fix 2: Close all workspaces on immersive switch
**Problem:** Switching to immersive mode leaves workspace windows open, hiding the world map.
**Fix:** In `pehSetMode('immersive')`, clear `state.pehverse.workspaces` and `state.pehverse.focus`.

### Fix 3: Two-column dashboard grid
**Problem:** All workspace tiles stacked in a single column.
**Fix:** Change `.peh-grid` to `display: grid; grid-template-columns: 1fr 1fr;`. Collapse to single column on mobile.

### Fix 4: Remove placeholder bodies
**Problem:** Workspace panels show "PLACEHOLDER · coming soon" even when live data exists.
**Fix:** Ensure `pehWorkspaceBody()` routes to `IkbiScenes.liveContainer()` for all registered workspaces. Remove `pehPlaceholderBody()` fallback for workspaces that have live renderers.

---

## Per-Repo Specific Changes

### ikbi (The Workshop)
- 7 scenes → simplify to 4: Heartwood (hub), Grove (terminal), Sacred Flame (tests), River's End (history)
- Merge Stone Tablets + Living Spring into Heartwood (builder is accessed from hub)
- Merge Stone Ring into Heartwood (modules are a panel, not a scene)
- TUI terminal: embed the grove-ws terminal at the top of the dashboard, always visible
- Dashboard layout: terminal (top, full width), then 2-col grid for other panels

### pehlichi (The Settlement)
- Keep scenes as-is (they're pehlichi-specific)
- Fix auto-open and grid layout
- Ensure bridge status panels show real data

### pehlichi-pub (Public Edition)
- Same as pehlichi but public-facing
- Remove any internal/private workspace references
- Simplify for new users

### nusika (Adaptive Learning)
- Scenes should reflect learning modules, not build engine concepts
- Fix auto-open and grid layout
- Ensure companion chat is prominent

### toba (Career Transformation)
- Scenes should reflect career search workflow
- Fix auto-open and grid layout
- Ensure job search panels are prominent

### howa (Agent Proving Ground)
- Scenes should reflect testing/evaluation workflow
- Fix auto-open and grid layout

### kokuli (Adversarial Testing)
- Scenes should reflect adversarial testing workflow
- Fix auto-open and grid layout

### luak (Scoreboard/Evidence)
- Scenes should reflect scoring/evidence workflow
- Fix auto-open and grid layout

---

## Implementation Order

1. ikbi (most complex, most used)
2. pehlichi (coordinator, second most used)
3. pehlichi-pub (public face)
4. nusika, toba, howa, kokuli, luak (in parallel)

## Verification

For each repo:
- Open the UI in browser
- Click "Immersive" — should show clean world map, no open windows
- Click "Dashboard" — should show workspace chooser, no auto-opened windows
- Click a hotspot — should open ONE workspace panel
- Dashboard grid should be two columns
- All workspace panels should show live data (not placeholders)
- Mobile view should collapse to single column
