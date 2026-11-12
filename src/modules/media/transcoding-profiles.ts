/**
 * Transcoding Profile Resolution and Validation Module
 *
 * Supported profiles:
 * - 360p:  maxWidth 640,  maxHeight 360,  targetBitrateKbps 800
 * - 480p:  maxWidth 854,  maxHeight 480,  targetBitrateKbps 1400
 * - 720p:  maxWidth 1280, maxHeight 720,  targetBitrateKbps 2800
 * - 1080p: maxWidth 1920, maxHeight 1080, targetBitrateKbps 5000
 *
 * Profile Semantics & Bounding Box Interpretation:
 * - Maximum Output Bounding Boxes: Profile specifications (360p, 480p, 720p, 1080p) represent
 *   MAXIMUM OUTPUT BOUNDING BOXES (maxWidth x maxHeight), NOT guaranteed exact output heights.
 * - Non-16:9 & Unusual Aspect Ratios:
 *   - The resolver strictly preserves the source aspect ratio and never introduces distortion,
 *     stretching, or synthetic letterboxing/pillarboxing at the profile resolution level.
 *   - For non-16:9 sources, the resolved output height is bounded by, but will frequently be less than,
 *     the nominal profile height.
 *     Examples:
 *       - 2.39:1 Cinemascope / Ultrawide source (1920x804):
 *         - 1080p profile box (1920x1080): source already fits (1920<=1920, 804<=1080) -> skipped (SOURCE_ALREADY_WITHIN_PROFILE).
 *         - 720p profile resolves to 1280x536 (height is 536, bounded by 720).
 *       - 1:1 Square video source (1000x1000):
 *         - 1080p profile box (1920x1080): source already fits (1000<=1920, 1000<=1080) -> skipped (SOURCE_ALREADY_WITHIN_PROFILE).
 *         - 720p profile resolves to 720x720 (height reduced from 1000 to 720).
 *         - 480p profile resolves to 480x480.
 *         - 360p profile resolves to 360x360.
 *       - 4:3 Classic TV source (1440x1080):
 *         - 1080p profile box (1920x1080): source already fits (1440<=1920, 1080<=1080) -> skipped (SOURCE_ALREADY_WITHIN_PROFILE).
 *         - 720p profile resolves to 960x720.
 *         - 480p profile resolves to 640x480.
 *         - 360p profile resolves to 480x360.
 *
 * Profile Eligibility Policy (Milestone 3.5.1 Policy Correction):
 * 1. Preserve the source aspect ratio.
 * 2. Never upscale.
 * 3. Generate a rendition only when it actually reduces the effective source dimensions.
 * 4. If the source already fits inside a profile's bounding box (effectiveWidth <= boxWidth && effectiveHeight <= boxHeight),
 *    skip it with structured reason: SOURCE_ALREADY_WITHIN_PROFILE.
 * 5. Reserve SOURCE_RESOLUTION_TOO_LOW for genuinely incompatible cases (e.g. unable to reduce dimensions or target < 2px).
 *
 * Even Output Dimension Guarantees & Flooring Strategy:
 * - Chroma Subsampling Compliance: Standard H.264/AAC video encoding with YUV 4:2:0 chroma subsampling
 *   strictly requires macroblocks with even integer pixel dimensions (width % 2 === 0, height % 2 === 0).
 * - Flooring Strategy: The resolver prefers flooring dimensions to even integers (`Math.floor(val / 2) * 2`)
 *   rather than rounding upward. Rounding upward can inadvertently exceed source dimensions (causing subtle upscaling)
 *   or profile bounding box maximums.
 * - Boundary Invariants: All resolved dimensions strictly satisfy:
 *   1. targetWidth <= effectiveWidth AND targetHeight <= effectiveHeight (never exceeds source).
 *   2. targetWidth <= boxWidth AND targetHeight <= boxHeight (never exceeds profile bounding box).
 *   3. targetWidth % 2 === 0 AND targetHeight % 2 === 0 (strictly even integers).
 *   4. targetWidth >= 2 AND targetHeight >= 2 (minimum valid dimension).
 *
 * Rotation Architecture & Double Rotation Prevention:
 * - Rotation can be embedded in MP4s in two primary locations:
 *   1. Modern MP4/MOV: `side_data_list` on the video stream where `side_data_type === 'Display Matrix'`
 *      with a numeric `rotation` property (e.g., -90, 90, 180).
 *   2. Legacy MP4/QuickTime: `tags.rotate` on the video stream or container format as a string (e.g. "90").
 * - When rotation is 90° or 270°, the effective display width and height are transposed.
 * - Double Rotation Prevention: FFmpeg's decoder autorotates video frames using container/stream
 *   display matrix metadata by default (unless `-noautorotate` is explicitly passed).
 *   Therefore, the decoded frames delivered into the filtergraph are already upright and match
 *   the effective display dimensions. Transcoding commands must apply ONLY scaling (`scale=w:h`),
 *   and must NOT insert additional `transpose` filters, which would cause double rotation.
 */

export type TranscodingProfileName = '360p' | '480p' | '720p' | '1080p';

export interface TranscodingProfileDefinition {
  readonly name: TranscodingProfileName;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly targetBitrateKbps: number;
}

export const SUPPORTED_PROFILES: Record<TranscodingProfileName, TranscodingProfileDefinition> = {
  '360p': {
    name: '360p',
    maxWidth: 640,
    maxHeight: 360,
    targetBitrateKbps: 800,
  },
  '480p': {
    name: '480p',
    maxWidth: 854,
    maxHeight: 480,
    targetBitrateKbps: 1400,
  },
  '720p': {
    name: '720p',
    maxWidth: 1280,
    maxHeight: 720,
    targetBitrateKbps: 2800,
  },
  '1080p': {
    name: '1080p',
    maxWidth: 1920,
    maxHeight: 1080,
    targetBitrateKbps: 5000,
  },
} as const;

export const ORDERED_PROFILE_NAMES: readonly TranscodingProfileName[] = [
  '360p',
  '480p',
  '720p',
  '1080p',
] as const;

export type SkipReasonCode = 'SOURCE_ALREADY_WITHIN_PROFILE' | 'SOURCE_RESOLUTION_TOO_LOW';

export interface TranscodingConfig {
  enabled?: boolean | undefined;
  profiles?: TranscodingProfileName[] | undefined;
}

export interface VideoDimensions {
  width: number;
  height: number;
  rotation?: number | undefined;
}

export interface ProfileResolutionInput {
  source: VideoDimensions;
  config?: TranscodingConfig | undefined;
}

export interface EligibleProfile {
  profile: TranscodingProfileName;
  targetWidth: number;
  targetHeight: number;
  scaleFactor: number;
  bitrateKbps: number;
}

export interface SkippedProfile {
  profile: string;
  reason: SkipReasonCode;
  message: string;
}

export type ProfileResolutionMode = 'automatic' | 'client_selected' | 'disabled';

export interface ProfileResolutionResult {
  mode: ProfileResolutionMode;
  eligible: EligibleProfile[];
  skipped: SkippedProfile[];
  sourceNormalized: {
    effectiveWidth: number;
    effectiveHeight: number;
    isPortrait: boolean;
  };
}

export class InvalidTranscodingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTranscodingConfigError';
  }
}

/**
 * Validates a client transcoding configuration.
 *
 * Rules:
 * - Rejects unknown profile names.
 * - Rejects duplicate profile names rather than silently deduplicating.
 * - Accepts empty profiles array (profiles: []).
 * - Accepts explicit enabled: true / false.
 * - Rejects enabled: false combined with non-empty profiles.
 * - Rejects unexpected properties.
 */
export function validateTranscodingConfig(input: unknown): {
  valid: boolean;
  error?: string;
  config?: TranscodingConfig;
} {
  if (input === undefined || input === null) {
    return { valid: true, config: {} };
  }

  if (typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, error: 'Transcoding configuration must be an object' };
  }

  const raw = input as Record<string, unknown>;

  // Check unexpected properties
  const allowedKeys = new Set(['enabled', 'profiles']);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return { valid: false, error: `Unexpected property in transcoding configuration: "${key}"` };
    }
  }

  let enabled: boolean | undefined = undefined;
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') {
      return { valid: false, error: 'Property "enabled" must be a boolean' };
    }
    enabled = raw.enabled;
  }

  let profiles: TranscodingProfileName[] | undefined = undefined;
  if (raw.profiles !== undefined) {
    if (!Array.isArray(raw.profiles)) {
      return { valid: false, error: 'Property "profiles" must be an array of profile names' };
    }

    // Rule: enabled: false and non-empty profiles cannot be combined
    if (enabled === false && raw.profiles.length > 0) {
      return {
        valid: false,
        error: 'Transcoding profiles cannot be specified when transcoding is disabled (enabled: false)',
      };
    }

    const seenProfiles = new Set<string>();
    const validatedProfiles: TranscodingProfileName[] = [];

    for (const item of raw.profiles) {
      if (typeof item !== 'string') {
        return { valid: false, error: 'Each profile in "profiles" must be a string' };
      }

      const trimmed = item.trim();
      if (!ORDERED_PROFILE_NAMES.includes(trimmed as TranscodingProfileName)) {
        return {
          valid: false,
          error: `Unknown profile "${trimmed}". Supported profiles are: ${ORDERED_PROFILE_NAMES.join(', ')}`,
        };
      }

      if (seenProfiles.has(trimmed)) {
        return {
          valid: false,
          error: `Duplicate profile "${trimmed}" in requested profiles list`,
        };
      }

      seenProfiles.add(trimmed);
      validatedProfiles.push(trimmed as TranscodingProfileName);
    }

    profiles = validatedProfiles;
  }

  return {
    valid: true,
    config: {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(profiles !== undefined ? { profiles } : {}),
    },
  };
}

/**
 * Normalizes effective display dimensions accounting for rotation metadata.
 * 90° and 270° rotations swap display width and height.
 */
export function normalizeSourceDimensions(dimensions: VideoDimensions): {
  effectiveWidth: number;
  effectiveHeight: number;
  isPortrait: boolean;
} {
  const rawWidth = dimensions.width;
  const rawHeight = dimensions.height;

  if (!Number.isSafeInteger(rawWidth) || rawWidth <= 0 || rawWidth > 16384 || !Number.isSafeInteger(rawHeight) || rawHeight <= 0 || rawHeight > 16384) {
    throw new Error(`Invalid source dimensions: ${dimensions.width}x${dimensions.height}`);
  }

  const rawRotation = dimensions.rotation ?? 0;
  if (!Number.isFinite(rawRotation)) throw new Error('Invalid source rotation');
  // Normalize rotation to 0..359 degrees
  const normalizedRotation = ((Math.round(rawRotation) % 360) + 360) % 360;
  const isSwapped = normalizedRotation === 90 || normalizedRotation === 270;

  const effectiveWidth = isSwapped ? rawHeight : rawWidth;
  const effectiveHeight = isSwapped ? rawWidth : rawHeight;
  const isPortrait = effectiveHeight > effectiveWidth;

  return {
    effectiveWidth,
    effectiveHeight,
    isPortrait,
  };
}

/**
 * Helper to floor dimension to the largest even integer less than or equal to val, minimum 2.
 * Uses Math.floor(val / 2) * 2.
 *
 * Preferring flooring over rounding upward guarantees that:
 * 1. Calculated dimensions never exceed the effective source dimensions (never upscales).
 * 2. Calculated dimensions never exceed profile bounding box maximum dimensions.
 * 3. Dimensions are strictly even integers (modulo 2 === 0), required for H.264/AAC 4:2:0 chroma subsampling.
 * 4. Dimensions are at least 2 pixels.
 */
export function floorToEven(val: number): number {
  const floored = Math.floor(val / 2) * 2;
  return Math.max(2, floored);
}

/**
 * Calculates aspect-ratio preserving target dimensions bounded by the profile box.
 * Never upscales source dimensions.
 *
 * Semantics:
 * - The profile (360p, 480p, 720p, 1080p) defines the MAXIMUM OUTPUT BOUNDING BOX.
 * - It does NOT guarantee exact output height for unusual or non-16:9 aspect ratios.
 * - Aspect ratio is strictly preserved via scale = min(boxWidth / effectiveWidth, boxHeight / effectiveHeight).
 * - Dimensions are floored to even integers of at least 2 and never exceed effective source or bounding box limits.
 */
export function calculateProfileDimensions(
  effectiveWidth: number,
  effectiveHeight: number,
  profile: TranscodingProfileDefinition,
  isPortrait: boolean
): {
  targetWidth: number;
  targetHeight: number;
  scaleFactor: number;
  isUpscaling: boolean;
  fitsWithinBox: boolean;
  reducesDimensions: boolean;
} {
  // Portrait orientation transposes the bounding box
  const boxWidth = isPortrait ? profile.maxHeight : profile.maxWidth;
  const boxHeight = isPortrait ? profile.maxWidth : profile.maxHeight;

  const fitsWithinBox = effectiveWidth <= boxWidth && effectiveHeight <= boxHeight;

  // Scale factor to fit inside the profile bounding box
  const scale = Math.min(boxWidth / effectiveWidth, boxHeight / effectiveHeight);

  // If scale > 1.0, the source is strictly smaller in both dimensions than the profile bounding box
  const isUpscaling = scale > 1.0;

  if (fitsWithinBox) {
    return {
      targetWidth: floorToEven(effectiveWidth),
      targetHeight: floorToEven(effectiveHeight),
      scaleFactor: 1.0,
      isUpscaling,
      fitsWithinBox: true,
      reducesDimensions: false,
    };
  }

  let targetWidth = floorToEven(effectiveWidth * scale);
  let targetHeight = floorToEven(effectiveHeight * scale);

  // Guard against any dimension exceeding profile bounding box or effective source dimensions
  if (targetWidth > boxWidth) {
    targetWidth = Math.floor(boxWidth / 2) * 2;
  }
  if (targetHeight > boxHeight) {
    targetHeight = Math.floor(boxHeight / 2) * 2;
  }
  if (targetWidth > effectiveWidth) {
    targetWidth = Math.floor(effectiveWidth / 2) * 2;
  }
  if (targetHeight > effectiveHeight) {
    targetHeight = Math.floor(effectiveHeight / 2) * 2;
  }

  // Ensure minimum 2
  targetWidth = Math.max(2, targetWidth);
  targetHeight = Math.max(2, targetHeight);

  const reducesDimensions =
    (targetWidth < effectiveWidth || targetHeight < effectiveHeight) &&
    targetWidth <= effectiveWidth &&
    targetHeight <= effectiveHeight;

  return {
    targetWidth,
    targetHeight,
    scaleFactor: scale,
    isUpscaling: false,
    fitsWithinBox: false,
    reducesDimensions,
  };
}

/**
 * Pure, deterministic transcoding profile resolution.
 *
 * Rules:
 * 1. Disabled mode: if config.enabled === false, returns 0 eligible profiles.
 * 2. Automatic mode: if no config or config.profiles is undefined, evaluates all 4 profiles in ascending order.
 * 3. Client-selected mode: if config.profiles is provided, evaluates only requested profiles in order.
 * 4. Empty profiles: if config.profiles is an empty array, returns 0 eligible profiles.
 * 5. Bounding box semantics: 360p, 480p, 720p, 1080p represent maximum bounding boxes, not fixed heights.
 * 6. Never upscale: aspect ratio is strictly preserved, and dimensions never exceed source dimensions.
 * 7. Dimension reduction requirement: generate a rendition only when it actually reduces the effective source dimensions.
 * 8. Already fits within box: if the source already fits inside a profile's bounding box, skip it with SOURCE_ALREADY_WITHIN_PROFILE.
 * 9. Incompatible resolution: reserve SOURCE_RESOLUTION_TOO_LOW for genuinely incompatible cases.
 * 10. Even dimensions: all target dimensions are floored even integers >= 2.
 */
export function resolveTranscodingProfiles(
  input: ProfileResolutionInput
): ProfileResolutionResult {
  const normalized = normalizeSourceDimensions(input.source);
  const { effectiveWidth, effectiveHeight, isPortrait } = normalized;

  // Validate configuration if supplied
  if (input.config !== undefined) {
    const validation = validateTranscodingConfig(input.config);
    if (!validation.valid) {
      throw new InvalidTranscodingConfigError(validation.error!);
    }
  }

  // 1. Explicitly disabled mode
  if (input.config && input.config.enabled === false) {
    return {
      mode: 'disabled',
      eligible: [],
      skipped: [],
      sourceNormalized: normalized,
    };
  }

  // 2. Determine mode and candidate profile names
  let mode: ProfileResolutionMode;
  let candidates: TranscodingProfileName[];

  if (input.config && Array.isArray(input.config.profiles)) {
    mode = 'client_selected';
    candidates = [...input.config.profiles];
  } else {
    mode = 'automatic';
    candidates = [...ORDERED_PROFILE_NAMES];
  }

  const eligible: EligibleProfile[] = [];
  const skipped: SkippedProfile[] = [];

  for (const candidate of candidates) {
    const profileDef = SUPPORTED_PROFILES[candidate];
    const boxWidth = isPortrait ? profileDef.maxHeight : profileDef.maxWidth;
    const boxHeight = isPortrait ? profileDef.maxWidth : profileDef.maxHeight;

    const dimResult = calculateProfileDimensions(
      effectiveWidth,
      effectiveHeight,
      profileDef,
      isPortrait
    );

    // Rule 4: If source already fits inside profile bounding box,
    // skip it with structured reason SOURCE_ALREADY_WITHIN_PROFILE
    if (dimResult.fitsWithinBox) {
      skipped.push({
        profile: candidate,
        reason: 'SOURCE_ALREADY_WITHIN_PROFILE',
        message: `Source resolution (${effectiveWidth}x${effectiveHeight}) already fits within profile bounding box (${boxWidth}x${boxHeight})`,
      });
      continue;
    }

    // Rule 3 & 5: Generate a rendition only when it actually reduces effective source dimensions.
    // Reserve SOURCE_RESOLUTION_TOO_LOW for genuinely incompatible cases.
    if (!dimResult.reducesDimensions || dimResult.targetWidth < 2 || dimResult.targetHeight < 2) {
      skipped.push({
        profile: candidate,
        reason: 'SOURCE_RESOLUTION_TOO_LOW',
        message: `Source resolution (${effectiveWidth}x${effectiveHeight}) cannot be downscaled to a valid rendition for profile (${boxWidth}x${boxHeight})`,
      });
      continue;
    }

    eligible.push({
      profile: profileDef.name,
      targetWidth: dimResult.targetWidth,
      targetHeight: dimResult.targetHeight,
      scaleFactor: dimResult.scaleFactor,
      bitrateKbps: profileDef.targetBitrateKbps,
    });
  }

  return {
    mode,
    eligible,
    skipped,
    sourceNormalized: normalized,
  };
}
