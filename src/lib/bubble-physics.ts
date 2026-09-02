/**
 * Physics constants + integrators ported from AOSP's bubble implementation, so
 * "multitask mode" moves the way Android's chat-head bubbles actually move
 * rather than the way a CSS transition guesses they move.
 *
 * Sources (aosp-mirror/platform_frameworks_base, master):
 *   libs/WindowManager/Shell/src/com/android/wm/shell/bubbles/animation/
 *     StackAnimationController.java
 *     ExpandedAnimationController.java
 *   libs/WindowManager/Shell/shared/src/com/android/wm/shell/shared/animation/
 *     Interpolators.java
 *
 * Android expresses springs as (stiffness, dampingRatio) with an implicit
 * mass of 1. We keep that exact representation and integrate it ourselves
 * instead of converting to CSS easings, because the drag interaction depends
 * on carrying *velocity* across state changes (finger -> fling -> settle),
 * which a duration+easing model structurally cannot express.
 *
 * 1dp is treated as 1 CSS px. That mapping is not physically exact, but dp and
 * CSS px are both ~1/160in reference units, so the felt motion matches.
 */

// ---------------------------------------------------------------------------
// Spring constants
// ---------------------------------------------------------------------------

/** androidx.dynamicanimation SpringForce named stiffnesses. */
export const STIFFNESS_HIGH = 10_000;
export const STIFFNESS_MEDIUM = 1500;
export const STIFFNESS_LOW = 200;
export const STIFFNESS_VERY_LOW = 50;

/** androidx.dynamicanimation SpringForce named damping ratios. */
export const DAMPING_NO_BOUNCY = 1.0;
export const DAMPING_LOW_BOUNCY = 0.75;
export const DAMPING_MEDIUM_BOUNCY = 0.5;
export const DAMPING_HIGH_BOUNCY = 0.2;

export type SpringConfig = { stiffness: number; damping: number };

/** StackAnimationController.STACK_SPRING_STIFFNESS = 700f, NO_BOUNCY. */
export const SPRING_STACK_SETTLE: SpringConfig = {
  stiffness: 700,
  damping: DAMPING_NO_BOUNCY,
};

/**
 * StackAnimationController.SPRING_TO_TOUCH_STIFFNESS = 12000.
 * The leader bubble does not rigidly track the finger — it springs to it very
 * stiffly. This is the single detail that makes bubbles feel like objects
 * rather than cursors, and it's what a plain `drag` handler loses.
 */
export const SPRING_TO_TOUCH: SpringConfig = {
  stiffness: 12_000,
  damping: DAMPING_NO_BOUNCY,
};

/**
 * StackAnimationController.CHAIN_STIFFNESS = 800, DEFAULT_BOUNCINESS = 0.9f.
 * Bubbles behind the leader chain off the one in front, so the stack trails
 * and overshoots slightly instead of moving as one rigid block.
 */
export const SPRING_CHAIN: SpringConfig = {
  stiffness: 800,
  damping: 0.9,
};

/** StackAnimationController.SPRING_AFTER_FLING_DAMPING_RATIO = 0.85f. */
export const SPRING_AFTER_FLING: SpringConfig = {
  stiffness: 700,
  damping: 0.85,
};

/** ExpandedAnimationController.EXPAND_COLLAPSE_ANIM_STIFFNESS = 400, NO_BOUNCY. */
export const SPRING_EXPAND_COLLAPSE: SpringConfig = {
  stiffness: 400,
  damping: DAMPING_NO_BOUNCY,
};

/**
 * ExpandedAnimationController.getSpringForce: STIFFNESS_LOW with
 * DAMPING_RATIO_MEDIUM_LOW_BOUNCY = 0.65f. Used for each bubble's slide into
 * the expanded row — loose and slightly bouncy, unlike the panel itself.
 */
export const SPRING_EXPANDED_ROW: SpringConfig = {
  stiffness: STIFFNESS_LOW,
  damping: 0.65,
};

// ---------------------------------------------------------------------------
// Fling + gesture constants
// ---------------------------------------------------------------------------

/** StackAnimationController.FLING_FRICTION = 1.9f. */
export const FLING_FRICTION = 1.9;

/**
 * androidx FlingAnimation's DragForce decays velocity by
 * exp(-friction * 4.2 * dt). The 4.2 is a magic constant inside the platform
 * implementation, not something we chose.
 */
export const DRAG_FORCE_CONSTANT = 4.2;

/**
 * StackAnimationController.ESCAPE_VELOCITY = 750f (dp/s). Fling faster than
 * this and the stack crosses to the opposite edge; slower and it falls back to
 * whichever edge it's nearest.
 */
export const ESCAPE_VELOCITY = 750;

/** StackAnimationController.FLING_TO_DISMISS_MIN_VELOCITY = 4000f. */
export const FLING_TO_DISMISS_MIN_VELOCITY = 4000;

// ---------------------------------------------------------------------------
// Dimensions (Shell/res/values/dimen.xml)
// ---------------------------------------------------------------------------

export const BUBBLE_SIZE = 60; // bubble_size
export const BUBBLE_BADGE_SIZE = 24; // bubble_badge_size
export const BUBBLE_TOUCH_PADDING = 12; // bubble_touch_padding
export const BUBBLE_SPACING = 3; // bubble_spacing (expanded row)
export const BUBBLE_PADDING_TOP = 16; // bubble_padding_top
export const BUBBLE_EXPANDED_VIEW_PADDING = 16; // bubble_expanded_view_padding
export const BUBBLE_DISMISS_ENCIRCLE_SIZE = 52; // bubble_dismiss_encircle_size

/** Lateral offset of each stacked bubble behind the leader. */
export const STACK_OFFSET = 6;

// ---------------------------------------------------------------------------
// Interpolators (Interpolators.java)
// ---------------------------------------------------------------------------

/** EMPHASIZED_ACCELERATE = PathInterpolator(0.3f, 0f, 0.8f, 0.15f) */
export const EMPHASIZED_ACCELERATE: [number, number, number, number] = [
  0.3, 0, 0.8, 0.15,
];

/** EMPHASIZED_DECELERATE = PathInterpolator(0.05f, 0.7f, 0.1f, 1f) */
export const EMPHASIZED_DECELERATE: [number, number, number, number] = [
  0.05, 0.7, 0.1, 1,
];

/** ExpandedAnimationController.EXPAND_COLLAPSE_TARGET_ANIM_DURATION = 175ms. */
export const EXPAND_COLLAPSE_DURATION = 0.175;

// ---------------------------------------------------------------------------
// Integrators
// ---------------------------------------------------------------------------

/**
 * Springs at STIFFNESS_HIGH / SPRING_TO_TOUCH blow up under semi-implicit Euler
 * at a 60Hz step (stability needs dt < 2/sqrt(k), and sqrt(12000) ≈ 110). We
 * substep to a fixed 240Hz so the stiff springs stay stable regardless of the
 * host display's refresh rate.
 */
const MAX_STEP = 1 / 240;

/** Below these thresholds the platform considers a spring at rest. */
const REST_DISPLACEMENT = 0.05;
const REST_VELOCITY = 0.05;

/**
 * One axis of spring motion. Mutable and stepped in place — this runs inside a
 * rAF loop for every bubble on every frame, so it deliberately allocates
 * nothing per step.
 */
export class Spring1D {
  value: number;
  velocity = 0;
  target: number;
  private stiffness: number;
  private dampingRatio: number;

  constructor(initial: number, config: SpringConfig = SPRING_STACK_SETTLE) {
    this.value = initial;
    this.target = initial;
    this.stiffness = config.stiffness;
    this.dampingRatio = config.damping;
  }

  setConfig(config: SpringConfig) {
    this.stiffness = config.stiffness;
    this.dampingRatio = config.damping;
  }

  /** Jump without animating — used when re-seeding after a viewport resize. */
  snapTo(value: number) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }

  isAtRest() {
    return (
      Math.abs(this.value - this.target) < REST_DISPLACEMENT &&
      Math.abs(this.velocity) < REST_VELOCITY
    );
  }

  /** @param dt seconds since last frame. */
  step(dt: number) {
    // Critical damping coefficient for mass = 1: c = 2 * zeta * sqrt(k).
    const c = 2 * this.dampingRatio * Math.sqrt(this.stiffness);
    let remaining = Math.min(dt, 0.064); // clamp tab-switch hitches
    while (remaining > 0) {
      const step = Math.min(remaining, MAX_STEP);
      const accel = -this.stiffness * (this.value - this.target) - c * this.velocity;
      this.velocity += accel * step;
      this.value += this.velocity * step;
      remaining -= step;
    }
    if (this.isAtRest()) {
      this.value = this.target;
      this.velocity = 0;
    }
  }
}

/**
 * Velocity decay matching androidx FlingAnimation's DragForce, used to project
 * where a fling would land so we can pick a settle edge before animating.
 */
export function decayVelocity(velocity: number, dt: number, friction = FLING_FRICTION) {
  return velocity * Math.exp(-friction * DRAG_FORCE_CONSTANT * dt);
}

/** Total distance a fling of `velocity` would cover before coming to rest. */
export function flingDistance(velocity: number, friction = FLING_FRICTION) {
  return velocity / (friction * DRAG_FORCE_CONSTANT);
}
