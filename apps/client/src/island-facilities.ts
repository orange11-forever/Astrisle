import type { GroundPoint } from './island-motion';
import { glasshouseAisle, glasshouseYaw, nurseryBed } from './garden-access';

export type LeisureActivity = 'sit' | 'tea' | 'swing' | 'tend';
export type FacilityId =
  | 'garden-bench'
  | 'tea-chair'
  | 'garden-swing'
  | 'nursery-bed'
  | 'glasshouse-aisle';
export interface IslandFacility {
  id: FacilityId;
  activity: LeisureActivity;
  name: string;
  position: GroundPoint;
  approach: GroundPoint;
  yaw: number;
  seatHeight: number;
  duration: number;
}

/** Geometry, navigation and characters share these contact points. Facing is local +Z. */
export const FACILITIES: Record<FacilityId, IslandFacility> = {
  'nursery-bed': {
    id: 'nursery-bed',
    activity: 'tend',
    name: '扦插床',
    position: nurseryBed,
    approach: nurseryBed,
    yaw: glasshouseYaw + Math.PI,
    seatHeight: 0,
    duration: 12,
  },
  'glasshouse-aisle': {
    id: 'glasshouse-aisle',
    activity: 'tend',
    name: '温室育苗台',
    position: glasshouseAisle,
    approach: glasshouseAisle,
    yaw: glasshouseYaw + Math.PI / 2,
    seatHeight: 0,
    duration: 12,
  },
  'garden-bench': {
    id: 'garden-bench',
    activity: 'sit',
    name: '花园长椅',
    position: [-2.4, 7.9],
    approach: [-2.4, 6.45],
    yaw: Math.PI,
    seatHeight: 0.55,
    duration: 15,
  },
  'tea-chair': {
    id: 'tea-chair',
    activity: 'tea',
    name: '树下茶席',
    position: [0, -7.65],
    approach: [1.5, -7.1],
    yaw: 0,
    seatHeight: 0.55,
    duration: 18,
  },
  'garden-swing': {
    id: 'garden-swing',
    activity: 'swing',
    name: '木秋千',
    position: [7.55, 0],
    approach: [5.95, 0],
    yaw: -Math.PI / 2,
    seatHeight: 0.55,
    duration: 22,
  },
};
export const SWING_PIVOT_HEIGHT = 2.8;
export const SWING_ROPE_LENGTH = SWING_PIVOT_HEIGHT - FACILITIES['garden-swing'].seatHeight;
export const TEA_TABLE: GroundPoint = [0, -6.55];
export const FACILITY_OBSTACLES: [number, number, number][] = [
  [-2.4, 7.9, 0.65],
  [0, -7.65, 0.4],
  [0, -6.55, 0.62],
  [7.55, 0, 0.8],
];
