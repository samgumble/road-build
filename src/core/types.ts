export interface V3 { x: number; y: number; z: number; }
export interface P2 { x: number; z: number; }
export type Stage = 'surveyed' | 'graded' | 'gravel' | 'paved' | 'painted';
export const STAGES: Stage[] = ['surveyed', 'graded', 'gravel', 'paved', 'painted'];
export type VehicleKind = 'excavator' | 'truck' | 'paver' | 'roller' | 'liner';
export interface RoadSample extends V3 { bridge: boolean; }
