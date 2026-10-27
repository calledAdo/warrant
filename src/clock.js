// The current time, or WARRANT_NOW when set, so a recorded run can be replayed exactly.
export const nowMs = () => (process.env.WARRANT_NOW ? Date.parse(process.env.WARRANT_NOW) : Date.now());
