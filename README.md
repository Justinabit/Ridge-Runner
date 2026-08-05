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
| `R` | Respawn on the road just behind you |
| `P` / `Esc` | Pause |

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
| `pickups.js` | Fuel cans |
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

## Testing

Physics changes are easy to get wrong and hard to eyeball, so they are worth
checking headlessly. `cannon-es` and the geometry modules run fine under Node —
you can import `roadgen.js`, `terrain.js` and `vehicle.js` directly, step the
world in a loop with a simple autopilot, and assert that the car stays on the
road and never drops below it.
