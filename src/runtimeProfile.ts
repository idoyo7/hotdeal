export type CycleMode = 'startup' | 'recurring';

export type CycleProfile = {
  name: CycleMode;
  maxPagesPerPoll: number;
  maxItemsPerPoll: number;
};

export const RECURRING_MAX_PAGES_PER_POLL = 1;
export const RECURRING_MAX_ITEMS_PER_POLL = 30;
export const STARTUP_MAX_PAGES_PER_POLL = 5;
export const STARTUP_MAX_ITEMS_PER_POLL = 120;

export const resolveCycleProfile = (firstRun: boolean): CycleProfile => {
  if (firstRun) {
    return {
      name: 'startup',
      maxPagesPerPoll: STARTUP_MAX_PAGES_PER_POLL,
      maxItemsPerPoll: STARTUP_MAX_ITEMS_PER_POLL,
    };
  }

  return {
    name: 'recurring',
    maxPagesPerPoll: RECURRING_MAX_PAGES_PER_POLL,
    maxItemsPerPoll: RECURRING_MAX_ITEMS_PER_POLL,
  };
};
