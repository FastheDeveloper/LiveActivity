import type { DeliveryState } from './modules/droptrack-live';

// The scripted delivery. Each step is a full snapshot of the dynamic state —
// exactly what a real backend would push, minus the courier's actual GPS.
// Shared by the phone dev console (App.tsx) and the web dispatcher console.
export type Step = {
  status: string;
  progress: number;
  stopsRemaining: number;
  etaMinutes: number;
};

export const STEPS: Step[] = [
  { status: 'Order placed', progress: 0.05, stopsRemaining: 4, etaMinutes: 25 },
  { status: 'Courier assigned', progress: 0.15, stopsRemaining: 4, etaMinutes: 22 },
  { status: 'Picked up your order', progress: 0.35, stopsRemaining: 3, etaMinutes: 18 },
  { status: 'On the way', progress: 0.55, stopsRemaining: 2, etaMinutes: 12 },
  { status: '2 stops away', progress: 0.7, stopsRemaining: 2, etaMinutes: 8 },
  { status: 'Next stop: you', progress: 0.85, stopsRemaining: 1, etaMinutes: 4 },
  { status: 'Arriving now 🛵', progress: 0.95, stopsRemaining: 0, etaMinutes: 1 },
];

export const DELIVERED: Step = {
  status: 'Delivered 🎉',
  progress: 1,
  stopsRemaining: 0,
  etaMinutes: 0,
};

export const ORDER = { orderId: 'DT-4521' };
export const RIDERS = ['Ade', 'Tunde', 'Chioma'];

export type Rider = { name: string; justReassigned: boolean };

export function toDeliveryState(step: Step, rider: Rider): DeliveryState {
  return {
    status: step.status,
    progress: step.progress,
    stopsRemaining: step.stopsRemaining,
    etaEpochMillis: Date.now() + step.etaMinutes * 60_000,
    courierName: rider.name,
    riderReassigned: rider.justReassigned,
  };
}
