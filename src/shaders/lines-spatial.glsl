// Continuous warped wall and floor grid.
LineSample lineWarpedGrid(float segment, float endpoint) {
  float sheet = floor(segment / 16384.0);
  float local = mod(segment, 16384.0);
  float path = floor(local / 64.0);
  float t = (mod(local, 64.0) + endpoint) / 64.0;
  float across = mod(path, 128.0) / 127.0;
  float flow = u_motion.y;
  float bass = u_audio.y;
  float firstTone = .75 * u_spectrum[4] + .25 * u_spectrum[5];
  float secondTone = .25 * u_spectrum[5] + .75 * u_spectrum[6];
  float floorTone = .65 * u_spectrum[7] + .35 * u_spectrum[6];
  vec2 uv = path < 128.0 ? vec2(t, across) : vec2(across, t);
  vec3 p;
  float bend = .62 + u_warp * .43;

  if (sheet < .5) {
    // An open wall runs beyond the frame. Two offset folds move through the
    // crosshatching, so the image reads as a whole space rather than one orb.
    vec2 wall = vec2(mix(-4.2, 4.2, uv.x), mix(-.88, 2.85, uv.y));
    vec2 center = vec2(-.88 + .28 * sin(flow * .16),
      .36 + .12 * u_spectrum[4] * cos(flow * .19));
    vec2 d = wall - center;
    float radius = dot(d * vec2(.62, .89), d * vec2(.62, .89));
    float fold = exp(-radius * .70);
    float twist = bend * (.58 + .12 * sin(flow * .23) + .30 * firstTone) * fold;
    wall = center + lineTurn(twist) * d;
    vec2 counterCenter = vec2(2.0 + .16 * u_spectrum[5] * cos(flow * .17),
      .65 + .15 * u_spectrum[6] * sin(-flow * .21 + 1.2));
    vec2 counter = (wall - counterCenter) * vec2(.72, 1.1);
    float second = exp(-dot(counter, counter));
    float firstPressure = .45 * bass + .275 * (u_spectrum[0] + u_spectrum[1]);
    float secondPressure = .45 * bass + .55 * u_spectrum[2];
    float z = -.92 + ((1.24 + .33 * firstTone) * fold * (1.0 + firstPressure * .12)
      - (.57 + .30 * secondTone) * second * (1.0 + secondPressure * .12)) * bend;
    wall.y += .13 * sin(wall.x * 1.0 - flow * .20) * bend;
    p = vec3(wall, z);
  } else {
    // The second grid is a floor stretching from the rear wall into the viewer.
    // Broad ridges and slow shear continue the room without opaque surfaces.
    vec2 ground = vec2(mix(-4.3, 4.3, uv.x), mix(-.92, 1.82, uv.y));
    vec2 d = ground - vec2(.95, -.1);
    float fold = exp(-dot(d * vec2(.72, 1.18), d * vec2(.72, 1.18)));
    // The floor answers a different partial, with an opposing travelling ridge.
    ground.x += (.30 + .24 * floorTone) * bend
      * sin(ground.y * 1.5 - flow * .18) * fold;
    float y = -.88 - (ground.y + .92) * .115;
    y += (.52 + .23 * floorTone) * bend * fold
      * (1.0 + (.45 * bass + .55 * u_spectrum[3]) * .12);
    y += .10 * u_spectrum[7] * sin(ground.x * 1.8 + flow * .25) * fold;
    y += .06 * sin(ground.x * 1.2 + flow * .21) * (ground.y + .92);
    p = vec3(ground.x, y, ground.y);
  }

  float major = 1.0 - step(.5, mod(path, 8.0));
  float secondary = 1.0 - step(.5, mod(path, 4.0));
  float weight = .20 + major * .38 + secondary * .06;
  if (sheet > .5) weight *= .90;
  float ink = clamp(.14 + across * .40 + sheet * .18, 0.0, 1.0);
  return LineSample(p, ink, weight);
}

LineSample spatialSample(float segment, float endpoint, int pattern) {
  return lineWarpedGrid(segment, endpoint);
}
