export const WORLD_SIZE = 512;
export const GRID_SIZE = 129;
export const CELL = WORLD_SIZE / (GRID_SIZE - 1); // 4
export const SNAP = 8;
export const WATER_LEVEL = 0;
export const ROAD_WIDTH = 6;
export const LANE_OFFSET = 1.5;
// Shared engineered road footprint. Rendering uses these values for the compacted shoulder and
// drainage ditch; growth/wilderness use the derived outer half-width so no tree or field grass can
// survive over those meshes merely because its center is outside the asphalt ribbon.
export const ROAD_SHOULDER_EXTRA_PER_SIDE = 1.35;
export const ROAD_DITCH_WIDTH = 0.42;
export const ROAD_DITCH_OUTER_GAP = 0.48;
export const ROAD_VEGETATION_MARGIN = 0.6;
export const ROAD_ENGINEERED_HALF_WIDTH = ROAD_WIDTH / 2
  + ROAD_SHOULDER_EXTRA_PER_SIDE
  + ROAD_DITCH_OUTER_GAP
  + ROAD_DITCH_WIDTH / 2
  + ROAD_VEGETATION_MARGIN;
export const MAX_ROAD_GRADE = 0.35;
export const SIM_DT = 1 / 60;
export const DAY_LENGTH = 240;
