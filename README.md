# Groundwork

Groundwork is a small zen toy about watching roads get built. You drag a line across
a low-poly island and a construction crew takes it from there — an excavator grades
the earth, a truck lays gravel, a paver lays asphalt with a roller trailing behind it,
a line truck paints the stripes. There's no score, no failure state, nothing to lose.
Cars start using the roads once they're finished, and over time trees, fields, and
small houses grow up along the corridors you've carved, so the island slowly turns
from bare terrain into something that looks lived-in. Day turns to night, it rains
occasionally, and you can just let it run.

## Controls

| Input | Action |
|---|---|
| LMB drag (on terrain) | Survey a new road — release to commit it, or let go somewhere invalid and the preview fades |
| LMB click (Demolish mode) | Remove the road under the cursor; the crew tears it up in reverse |
| RMB drag | Orbit the camera |
| MMB drag, or W/A/S/D | Pan the camera |
| Scroll wheel | Zoom, dollying toward the point under the cursor |
| Toolbar: Draw / Demolish | Switch the active tool (click the active one again to deselect) |
| Toolbar: 1× / 4× / 16× | Simulation speed |
| Toolbar: Pause / Resume, or Space | Freeze/resume the simulation without losing your view |
| Toolbar: Guide, or H / ? | Open the live site overview and control reference |
| Toolbar: New World | Start a fresh island from a seed |
| Toolbar: Photo | Save a PNG screenshot of the current view |
| Toolbar: Mute | Toggle audio |

Leave the camera alone for 20 seconds and it drifts into a slow cinematic orbit;
any input snaps it back to your control immediately.

## Seeds

The island, its roads, and its growth are all deterministic from a string seed.
Visit `?seed=<anything>` to load a specific world:

```
http://localhost:5173/?seed=amber-valley
```

Without a `seed` param, the game resumes your last autosaved world (localStorage),
falling back to a fresh random seed if there's nothing to resume.

## Development

```
npm install
npm run dev      # start the dev server
npm test         # run the unit test suite (vitest)
npm run build    # typecheck (tsc --noEmit) + production build (vite)
```

## Architecture

Groundwork is built as a set of small, mostly-independent modules that talk to each
other only through an event bus — nothing reaches into another module's internals.
Simulation code (`src/sim/`: terrain heightfield, road graph, construction queue,
traffic, growth) is renderer-free, deterministic from its seed, and has no `three`
imports, which is what makes it fast to unit test in isolation (see `tests/`).
Rendering code (`src/render/`, `src/input/`, `src/ui/`) listens for sim events and
draws the current state — roads as extruded ribbon meshes staged by construction
progress, scenery and traffic as instanced meshes, particles for dust/steam/rain — and
never mutates sim state directly except through the draw and demolish tools. The
game loop (`src/core/loop.ts`) runs the simulation on a fixed timestep independent of
the variable-rate render callback, so behavior stays consistent across machines and
time-scale settings. For the full design rationale and the original task breakdown,
see `docs/superpowers/specs/2026-07-02-groundwork-zen-road-builder-design.md` and
`docs/superpowers/plans/2026-07-02-groundwork-implementation.md`. For a concise handoff for
future contributors or coding agents, start with [`docs/HANDOFF.md`](docs/HANDOFF.md).

## Credits

All 3D models are CC0 (public domain) assets by [Kenney](https://kenney.nl), used
unmodified:

- Cars — [Car Kit](https://kenney.nl/assets/car-kit) (`public/models/cars/`)
- Trees — [Nature Kit](https://kenney.nl/assets/nature-kit) (`public/models/scenery/nature/`)
- Houses — [City Kit (Suburban)](https://kenney.nl/assets/city-kit-suburban) (`public/models/scenery/suburban/`)
- Buildings — [City Kit (Commercial)](https://kenney.nl/assets/city-kit-commercial) (`public/models/scenery/commercial/`)

See the `LICENSE.txt` alongside each asset directory for the exact file list and
license text. No attribution is required by CC0, but it's given here anyway because
Kenney's packs are consistently excellent and worth pointing people to.

Construction, traffic, weather, and wildlife audio is synthesized at runtime with Web Audio.
The optional ambient music rotation uses bundled CC0 tracks; full provenance is in
`public/music/LICENSE.txt`.

## License

The Groundwork source code is licensed under the MIT License — see `LICENSE`.
The bundled Kenney assets under `public/models/` are CC0 and licensed separately
as noted above.
