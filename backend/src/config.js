/** Central config — everything overridable via environment variables. */
export const PORT = process.env.PORT || 8321;

/**
 * In production, registrations stay 'pending_verification' until the
 * 4-stage check (NIN/ID, skill test, guarantors, address) passes.
 * In dev/demo we auto-verify so new pros appear in listings immediately.
 */
export const AUTO_VERIFY = process.env.AUTO_VERIFY !== 'false';

/** Avatar colors assigned to new pros (brand palette). */
export const AVATAR_PALETTE = ['#0e7a4a', '#b0731a', '#4655c4', '#c2452f', '#7a3fa0', '#12876f', '#2f6ec2'];
