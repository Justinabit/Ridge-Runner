# Ridge Runner

A low-poly, endlessly-streamed hill-climb driving game. Built with
[three.js](https://threejs.org/) for rendering and
[cannon-es](https://pmndrs.github.io/cannon-es/) for physics. No build step and
no dependencies to install: both libraries load from a CDN via an import map.

## Running it locally

The game uses ES modules, so opening `index.html` directly with `file://` will
not work — the browser blocks module imports from the filesystem. Serve the
folder over HTTP instead:

```bash
# any one of these works
python3 -m http.server 8000
npx serve .
php -S localhost:8000
```

Then open <http://localhost:8000>.

## Controls

| Key | Action |
| --- | --- |
| `W` / `↑` | Throttle |
| `S` / `↓` | Brake, and reverse once stopped |
| `A` / `D` | Steer on the ground, tilt the chassis in the air |
| `Space` | Handbrake (rear axle only, so it slides) |
| `C` | Toggle chase / cockpit camera |
| `M` | Mute |
| `R` | Respawn just behind you, at the cost of 10 hull |
| `P` | Pause |
| `Esc` | Pause; from the pause or crash screen, back to the main menu |

## Playing

Survive as long as you can. Two resources run against you:

- **Fuel** burns constantly and faster on the throttle. Yellow cans restore it.
  Collecting every can is roughly break-even at speed, so missing them is what
  kills you.
- **Hull** only ever goes down. Rocks and barrels damage it; oil slicks don't
  damage you but strip your grip for a moment, which is often worse.

| Pickup | Effect |
| --- | --- |
| Yellow can | +22% fuel |
| Orange cone | Speed boost for 5s |
| Blue octahedron | Shield for 8s, absorbs hazard hits |
| Purple ring | Double score for 10s |

On touch devices the four on-screen buttons map to the same controls.

## How it works

| File | Responsibility |
| --- | --- |
| `main.js` | Boot sequence, game loop, HUD, scoring, fuel |
| `roadgen.js` | The road as a pure function of `z` — position, tangent, banking |
| `terrain.js` | Streams road chunks in and out around the car, builds their meshes and colliders |
| `vehicle.js` | Chassis, wheels, steering, drivetrain, crash detection |
| `camera.js` | Chase and cockpit cameras |
| `zones.js` | Sky, lighting, fog and scenery per biome |
| `pickups.js` | Fuel and power-up pickups |
| `hazards.js` | Rocks, barrels and oil slicks |
| `scenery.js` | Roadside trees, rocks, grass and street lamps |
| `effects.js` | Pooled particle systems (dust, sparks, boost trail) |
| `audio.js` | Procedural Web Audio: engine, wind, skid, music, one-shots |
| `noise.js` | Deterministic value noise |

The road is never stored, only sampled. `roadgen.js` maps a distance `z` to a
point and a local coordinate frame, and everything else — the visible ribbon,
the physics mesh, guardrail placement, scenery, spawn points — derives from that
same function. Two chunks that share a boundary sample the identical `z`, so
they always meet with no seam.

### Coordinate convention

The car drives toward **+Z**. The road frame is right-handed: `right = up ×
tangent` and `roadUp = tangent × right`. This matters more than it looks like it
should — getting the handedness backwards winds every road triangle the wrong
way, which makes the surface invisible to three.js (back-face culling) *and*
invisible to cannon-es's wheel raycasts (which skip back faces), so the car
falls straight through the world.

### Physics notes

- Wheel contact is a raycast reaching `suspensionRestLength + radius` (~1 m)
  below each wheel mount. Anything that lets the car move further than that in
  one step lets it tunnel through the road, which is why the car has a top
  speed and why the fixed timestep is 1/120 rather than 1/60.
- `RaycastVehicle` models no aerodynamic drag, so drag and rolling resistance
  are applied by hand in `vehicle.js`. Without them engine force is unopposed
  and the car accelerates without bound.
- `Body.applyForce(force, relativePoint)` takes a point **relative to the centre
  of mass**, not a world position. Passing a world position fabricates enormous
  torque and destroys the simulation.

### Audio

`audio.js` synthesises everything at runtime — there are no sound files. The
engine is two detuned oscillators through a lowpass that opens with revs, wind
and tyre squeal are one noise source through two bandpass filters, and the music
is a scheduled arpeggio. Browsers block audio until a user gesture, so the
context is created on the first click of START and every method is a no-op
before then.

## Testing

Physics changes are easy to get wrong and hard to eyeball, so they are worth
checking headlessly. `cannon-es` and the geometry modules run fine under Node:
import `roadgen.js`, `terrain.js` and `vehicle.js` directly, step the world in a
loop with a simple autopilot, and assert the car stays on the road.

Two things that caught real bugs here and are worth keeping in mind:

- **`node --check` is not a syntax gate for this project.** It parses files as
  CommonJS scripts, and it happily accepted a full-width Unicode digit that made
  `camera.js` fail to import. Parse with `acorn` using `sourceType: 'module'`,
  or just `import()` the module.
- **Assert against the screen, not the world.** Steering was verified as
  "positive steer moves the car toward +X" and shipped inverted, because the car
  drives along +Z with the camera behind it, which puts +X on the *left* of the
  screen. The control test now projects the car's displacement onto the camera's
  screen-right vector instead.
