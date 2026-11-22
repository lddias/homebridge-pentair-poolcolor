'use strict';
// Unit tests for hueToColorName (pure function, no hardware needed).
// Run: node test-color-mapping.js
// node-screenlogic is stubbed: index.js only needs its LIGHT_CMD_COLOR_*
// constants at load time; the color mapping itself is pure.
const Module = require('module');
const stub = {
  LIGHT_CMD_COLOR_RED: 0,
  LIGHT_CMD_COLOR_GREEN: 1,
  LIGHT_CMD_COLOR_BLUE: 2,
  LIGHT_CMD_COLOR_PURPLE: 3,
  LIGHT_CMD_COLOR_WHITE: 4,
  UnitConnection: class {},
  FindUnits: class {},
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'node-screenlogic') return stub;
  return origLoad.apply(this, arguments);
};

const { hueToColorName } = require('./index.js');

let failures = 0;
function check(hue, sat, expected, label) {
  const got = hueToColorName(hue, sat);
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  hue=${hue} sat=${sat} -> ${got} (expected ${expected})  ${label}`);
}

// Low saturation is white, any hue
check(0, 0, 'white', 'desaturated red');
check(200, 10, 'white', 'desaturated blue');
check(350, 14, 'white', 'just under threshold');

// Warm white from Siri: saturated amber hue -> white, not red
check(35, 100, 'white', 'Siri warm white (hue 35, full sat)');
check(30, 80, 'white', 'warm amber');
check(45, 100, 'white', 'amber');
check(60, 100, 'white', 'yellow edge of warm band');

// Pure red still red
check(0, 100, 'red', 'pure red');
check(10, 100, 'red', 'near-red');
check(350, 100, 'red', 'red wrapping past 360');

// Other fixed colors unchanged
check(120, 100, 'green', 'pure green');
check(90, 100, 'green', 'yellow-green snaps green');
check(240, 100, 'blue', 'pure blue');
check(285, 100, 'purple', 'pure purple');
check(200, 100, 'blue', 'cyan-blue snaps blue');
check(320, 100, 'purple', 'magenta snaps purple');

// Hue normalization
check(395, 100, 'white', '395 wraps to 35 (warm)');
check(-10, 100, 'red', '-10 wraps to 350 (red)');

if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nAll color-mapping tests passed.');
