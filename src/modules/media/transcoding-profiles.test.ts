import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUPPORTED_PROFILES,
  ORDERED_PROFILE_NAMES,
  InvalidTranscodingConfigError,
  validateTranscodingConfig,
  normalizeSourceDimensions,
  floorToEven,
  calculateProfileDimensions,
  resolveTranscodingProfiles,
  type ProfileResolutionInput,
  type SkipReasonCode,
} from './transcoding-profiles.js';

describe('Transcoding Profile Resolution Suite (Milestone 3.5.1 Policy Correction)', () => {
  describe('1. Transcoding Configuration Validation (validateTranscodingConfig)', () => {
    it('accepts undefined, null, or empty object as valid defaults', () => {
      assert.deepStrictEqual(validateTranscodingConfig(undefined), { valid: true, config: {} });
      assert.deepStrictEqual(validateTranscodingConfig(null), { valid: true, config: {} });
      assert.deepStrictEqual(validateTranscodingConfig({}), { valid: true, config: {} });
    });

    it('accepts explicit enabled: true / false', () => {
      assert.deepStrictEqual(validateTranscodingConfig({ enabled: true }), {
        valid: true,
        config: { enabled: true },
      });
      assert.deepStrictEqual(validateTranscodingConfig({ enabled: false }), {
        valid: true,
        config: { enabled: false },
      });
    });

    it('accepts valid profile lists in any order', () => {
      const res = validateTranscodingConfig({ profiles: ['720p', '360p'] });
      assert.deepStrictEqual(res, {
        valid: true,
        config: { profiles: ['720p', '360p'] },
      });
    });

    it('preserves support for an empty profile list (profiles: [])', () => {
      const res = validateTranscodingConfig({ profiles: [] });
      assert.deepStrictEqual(res, {
        valid: true,
        config: { profiles: [] },
      });
    });

    it('accepts enabled: false with empty profiles array', () => {
      const res = validateTranscodingConfig({ enabled: false, profiles: [] });
      assert.deepStrictEqual(res, {
        valid: true,
        config: { enabled: false, profiles: [] },
      });
    });

    it('rejects enabled: false combined with non-empty profiles', () => {
      const res = validateTranscodingConfig({ enabled: false, profiles: ['720p'] });
      assert.strictEqual(res.valid, false);
      if (!res.valid) {
        assert.match(res.error!, /cannot be specified when transcoding is disabled/);
      }
    });

    it('rejects unknown profile names with descriptive error', () => {
      const res = validateTranscodingConfig({ profiles: ['4k'] });
      assert.strictEqual(res.valid, false);
      if (!res.valid) {
        assert.match(res.error!, /Unknown profile "4k"/);
        assert.match(res.error!, /360p, 480p, 720p, 1080p/);
      }
    });

    it('rejects duplicate profile names rather than silently deduplicating', () => {
      const res = validateTranscodingConfig({ profiles: ['720p', '720p'] });
      assert.strictEqual(res.valid, false);
      if (!res.valid) {
        assert.match(res.error!, /Duplicate profile "720p"/);
      }
    });

    it('rejects non-object or array inputs', () => {
      assert.strictEqual(validateTranscodingConfig('invalid').valid, false);
      assert.strictEqual(validateTranscodingConfig(123).valid, false);
      assert.strictEqual(validateTranscodingConfig(['720p']).valid, false);
    });

    it('rejects unexpected properties in configuration', () => {
      const res = validateTranscodingConfig({ enabled: true, extraProperty: 'bad' });
      assert.strictEqual(res.valid, false);
      if (!res.valid) {
        assert.match(res.error!, /Unexpected property.*"extraProperty"/);
      }
    });

    it('rejects non-boolean enabled property', () => {
      const res = validateTranscodingConfig({ enabled: 'true' as any });
      assert.strictEqual(res.valid, false);
      if (!res.valid) {
        assert.match(res.error!, /Property "enabled" must be a boolean/);
      }
    });

    it('rejects non-array profiles property', () => {
      const res = validateTranscodingConfig({ profiles: '720p' as any });
      assert.strictEqual(res.valid, false);
      if (!res.valid) {
        assert.match(res.error!, /Property "profiles" must be an array/);
      }
    });
  });

  describe('2. Dimension Normalization & Rotation', () => {
    it('normalizes standard landscape without rotation', () => {
      const res = normalizeSourceDimensions({ width: 1920, height: 1080 });
      assert.strictEqual(res.effectiveWidth, 1920);
      assert.strictEqual(res.effectiveHeight, 1080);
      assert.strictEqual(res.isPortrait, false);
    });

    it('normalizes standard portrait without rotation', () => {
      const res = normalizeSourceDimensions({ width: 1080, height: 1920 });
      assert.strictEqual(res.effectiveWidth, 1080);
      assert.strictEqual(res.effectiveHeight, 1920);
      assert.strictEqual(res.isPortrait, true);
    });

    it('transposes coded dimensions on 90° rotation', () => {
      const res = normalizeSourceDimensions({ width: 1920, height: 1080, rotation: 90 });
      assert.strictEqual(res.effectiveWidth, 1080);
      assert.strictEqual(res.effectiveHeight, 1920);
      assert.strictEqual(res.isPortrait, true);
    });

    it('transposes coded dimensions on 270° rotation', () => {
      const res = normalizeSourceDimensions({ width: 1280, height: 720, rotation: 270 });
      assert.strictEqual(res.effectiveWidth, 720);
      assert.strictEqual(res.effectiveHeight, 1280);
      assert.strictEqual(res.isPortrait, true);
    });

    it('preserves orientation on 180° rotation', () => {
      const res = normalizeSourceDimensions({ width: 1920, height: 1080, rotation: 180 });
      assert.strictEqual(res.effectiveWidth, 1920);
      assert.strictEqual(res.effectiveHeight, 1080);
      assert.strictEqual(res.isPortrait, false);
    });

    it('handles negative or out-of-range rotation degrees modulo 360', () => {
      const res = normalizeSourceDimensions({ width: 1280, height: 720, rotation: -90 });
      // -90 === 270 -> swapped
      assert.strictEqual(res.effectiveWidth, 720);
      assert.strictEqual(res.effectiveHeight, 1280);
      assert.strictEqual(res.isPortrait, true);
    });

    it('throws error on non-positive or non-finite dimensions', () => {
      assert.throws(() => normalizeSourceDimensions({ width: 0, height: 1080 }), /Invalid source dimensions/);
      assert.throws(() => normalizeSourceDimensions({ width: 1920, height: -5 }), /Invalid source dimensions/);
      assert.throws(() => normalizeSourceDimensions({ width: NaN, height: 1080 }), /Invalid source dimensions/);
    });
  });

  describe('3. Automatic Profile Selection (Mode: automatic)', () => {
    it('generates all 4 profiles for a 4K source (3840x2160)', () => {
      const result = resolveTranscodingProfiles({
        source: { width: 3840, height: 2160 },
      });

      assert.strictEqual(result.mode, 'automatic');
      assert.strictEqual(result.eligible.length, 4);
      assert.strictEqual(result.skipped.length, 0);

      const profiles = result.eligible.map((e) => e.profile);
      assert.deepStrictEqual(profiles, ['360p', '480p', '720p', '1080p']);

      // 360p
      assert.strictEqual(result.eligible[0]?.targetWidth, 640);
      assert.strictEqual(result.eligible[0]?.targetHeight, 360);
      // 480p
      assert.strictEqual(result.eligible[1]?.targetWidth, 852);
      assert.strictEqual(result.eligible[1]?.targetHeight, 480);
      // 720p
      assert.strictEqual(result.eligible[2]?.targetWidth, 1280);
      assert.strictEqual(result.eligible[2]?.targetHeight, 720);
      // 1080p
      assert.strictEqual(result.eligible[3]?.targetWidth, 1920);
      assert.strictEqual(result.eligible[3]?.targetHeight, 1080);
    });

    it('generates 3 downscaled profiles for a 1080p source and skips 1080p with SOURCE_ALREADY_WITHIN_PROFILE', () => {
      const result = resolveTranscodingProfiles({
        source: { width: 1920, height: 1080 },
      });

      assert.strictEqual(result.mode, 'automatic');
      assert.strictEqual(result.eligible.length, 3);
      assert.deepStrictEqual(result.eligible.map((e) => e.profile), ['360p', '480p', '720p']);

      assert.strictEqual(result.skipped.length, 1);
      assert.strictEqual(result.skipped[0]?.profile, '1080p');
      assert.strictEqual(result.skipped[0]?.reason, 'SOURCE_ALREADY_WITHIN_PROFILE');

      // 360p
      assert.strictEqual(result.eligible[0]?.targetWidth, 640);
      assert.strictEqual(result.eligible[0]?.targetHeight, 360);
      // 480p
      assert.strictEqual(result.eligible[1]?.targetWidth, 852);
      assert.strictEqual(result.eligible[1]?.targetHeight, 480);
      // 720p
      assert.strictEqual(result.eligible[2]?.targetWidth, 1280);
      assert.strictEqual(result.eligible[2]?.targetHeight, 720);
    });

    it('generates 360p and 480p for a 720p source and skips 720p and 1080p with SOURCE_ALREADY_WITHIN_PROFILE', () => {
      const result = resolveTranscodingProfiles({
        source: { width: 1280, height: 720 },
      });

      assert.strictEqual(result.mode, 'automatic');
      assert.strictEqual(result.eligible.length, 2);
      assert.deepStrictEqual(result.eligible.map((e) => e.profile), ['360p', '480p']);

      assert.strictEqual(result.skipped.length, 2);
      assert.deepStrictEqual(result.skipped.map((s) => s.profile), ['720p', '1080p']);
      assert.ok(result.skipped.every((s) => s.reason === 'SOURCE_ALREADY_WITHIN_PROFILE'));
    });

    it('skips all profiles for a 360p source (640x360) because it already fits inside all bounding boxes', () => {
      const result = resolveTranscodingProfiles({
        source: { width: 640, height: 360 },
      });

      assert.strictEqual(result.eligible.length, 0);
      assert.strictEqual(result.skipped.length, 4);
      assert.deepStrictEqual(
        result.skipped.map((s) => s.profile),
        ['360p', '480p', '720p', '1080p']
      );
      assert.ok(result.skipped.every((s) => s.reason === 'SOURCE_ALREADY_WITHIN_PROFILE'));
    });

    it('skips all profiles if source is lower than 360p (e.g. 320x240) because it already fits within bounding boxes', () => {
      const result = resolveTranscodingProfiles({
        source: { width: 320, height: 240 },
      });

      assert.strictEqual(result.eligible.length, 0);
      assert.strictEqual(result.skipped.length, 4);
      assert.ok(result.skipped.every((s) => s.reason === 'SOURCE_ALREADY_WITHIN_PROFILE'));
    });
  });

  describe('4. Client-Selected Profiles (Mode: client_selected)', () => {
    it('generates only requested profiles when they reduce dimensions', () => {
      const result = resolveTranscodingProfiles({
        source: { width: 1920, height: 1080 },
        config: { profiles: ['720p', '360p'] },
      });

      assert.strictEqual(result.mode, 'client_selected');
      assert.strictEqual(result.eligible.length, 2);
      assert.deepStrictEqual(result.eligible.map((e) => e.profile), ['720p', '360p']);
      assert.strictEqual(result.skipped.length, 0);
    });

    it('skips profile if source already fits within it (e.g. 1080p on a 1280x720 source)', () => {
      const result = resolveTranscodingProfiles({
        source: { width: 1280, height: 720 },
        config: { profiles: ['360p', '720p', '1080p'] },
      });

      assert.strictEqual(result.mode, 'client_selected');
      assert.strictEqual(result.eligible.length, 1);
      assert.deepStrictEqual(result.eligible.map((e) => e.profile), ['360p']);

      assert.strictEqual(result.skipped.length, 2);
      assert.deepStrictEqual(result.skipped.map((s) => s.profile), ['720p', '1080p']);
      assert.ok(result.skipped.every((s) => s.reason === 'SOURCE_ALREADY_WITHIN_PROFILE'));
    });

    it('throws InvalidTranscodingConfigError on duplicate requested profiles', () => {
      assert.throws(
        () =>
          resolveTranscodingProfiles({
            source: { width: 1920, height: 1080 },
            config: { profiles: ['720p', '360p', '720p'] },
          }),
        (err: any) => {
          assert.ok(err instanceof InvalidTranscodingConfigError);
          assert.match(err.message, /Duplicate profile "720p"/);
          return true;
        }
      );
    });

    it('throws InvalidTranscodingConfigError on unknown requested profiles', () => {
      assert.throws(
        () =>
          resolveTranscodingProfiles({
            source: { width: 1920, height: 1080 },
            config: { profiles: ['720p', '4k' as any] },
          }),
        (err: any) => {
          assert.ok(err instanceof InvalidTranscodingConfigError);
          assert.match(err.message, /Unknown profile "4k"/);
          return true;
        }
      );
    });
  });

  describe('5. Disabled Transcoding (Mode: disabled)', () => {
    it('returns empty eligible list when enabled is false and profiles omitted', () => {
      const result = resolveTranscodingProfiles({
        source: { width: 1920, height: 1080 },
        config: { enabled: false },
      });

      assert.strictEqual(result.mode, 'disabled');
      assert.strictEqual(result.eligible.length, 0);
      assert.strictEqual(result.skipped.length, 0);
    });

    it('returns empty eligible list when enabled is false and profiles is []', () => {
      const result = resolveTranscodingProfiles({
        source: { width: 1920, height: 1080 },
        config: { enabled: false, profiles: [] },
      });

      assert.strictEqual(result.mode, 'disabled');
      assert.strictEqual(result.eligible.length, 0);
      assert.strictEqual(result.skipped.length, 0);
    });

    it('throws InvalidTranscodingConfigError when enabled: false is combined with non-empty profiles', () => {
      assert.throws(
        () =>
          resolveTranscodingProfiles({
            source: { width: 1920, height: 1080 },
            config: { enabled: false, profiles: ['720p'] },
          }),
        (err: any) => {
          assert.ok(err instanceof InvalidTranscodingConfigError);
          assert.match(err.message, /cannot be specified when transcoding is disabled/);
          return true;
        }
      );
    });
  });

  describe('6. Empty Profile Selection', () => {
    it('returns empty lists when client provides empty profiles array', () => {
      const result = resolveTranscodingProfiles({
        source: { width: 1920, height: 1080 },
        config: { profiles: [] },
      });

      assert.strictEqual(result.mode, 'client_selected');
      assert.strictEqual(result.eligible.length, 0);
      assert.strictEqual(result.skipped.length, 0);
    });
  });

  describe('7. Portrait Videos & Mobile Aspect Ratios', () => {
    it('skips 1080p portrait for a 1080x1920 source and generates downscaled renditions', () => {
      const result = resolveTranscodingProfiles({
        source: { width: 1080, height: 1920 },
      });

      assert.strictEqual(result.sourceNormalized.isPortrait, true);
      assert.strictEqual(result.eligible.length, 3);
      assert.deepStrictEqual(result.eligible.map((e) => e.profile), ['360p', '480p', '720p']);

      assert.strictEqual(result.skipped.length, 1);
      assert.strictEqual(result.skipped[0]?.profile, '1080p');
      assert.strictEqual(result.skipped[0]?.reason, 'SOURCE_ALREADY_WITHIN_PROFILE');

      // 360p portrait: 360x640
      assert.strictEqual(result.eligible[0]?.targetWidth, 360);
      assert.strictEqual(result.eligible[0]?.targetHeight, 640);

      // 480p portrait: 480x854 bounding box, targetHeight is floored to even 852
      assert.strictEqual(result.eligible[1]?.targetWidth, 480);
      assert.strictEqual(result.eligible[1]?.targetHeight, 852);

      // 720p portrait: 720x1280
      assert.strictEqual(result.eligible[2]?.targetWidth, 720);
      assert.strictEqual(result.eligible[2]?.targetHeight, 1280);
    });

    it('generates all 4 portrait profiles for a 4K portrait video (2160x3840)', () => {
      const result = resolveTranscodingProfiles({
        source: { width: 2160, height: 3840 },
      });

      assert.strictEqual(result.eligible.length, 4);
      assert.strictEqual(result.skipped.length, 0);

      assert.strictEqual(result.eligible[3]?.profile, '1080p');
      assert.strictEqual(result.eligible[3]?.targetWidth, 1080);
      assert.strictEqual(result.eligible[3]?.targetHeight, 1920);
    });

    it('skips 720p and 1080p portrait for a 720x1280 portrait source', () => {
      const result = resolveTranscodingProfiles({
        source: { width: 720, height: 1280 },
      });

      assert.strictEqual(result.eligible.length, 2);
      assert.deepStrictEqual(result.eligible.map((e) => e.profile), ['360p', '480p']);

      assert.strictEqual(result.skipped.length, 2);
      assert.deepStrictEqual(result.skipped.map((s) => s.profile), ['720p', '1080p']);
      assert.ok(result.skipped.every((s) => s.reason === 'SOURCE_ALREADY_WITHIN_PROFILE'));
    });

    it('handles portrait video oriented via 90° rotation metadata', () => {
      // Camera recorded 1920x1080 coded with 90° rotation -> effective 1080x1920 display
      const result = resolveTranscodingProfiles({
        source: { width: 1920, height: 1080, rotation: 90 },
      });

      assert.strictEqual(result.sourceNormalized.isPortrait, true);
      assert.strictEqual(result.sourceNormalized.effectiveWidth, 1080);
      assert.strictEqual(result.sourceNormalized.effectiveHeight, 1920);

      // 1080p already fits in portrait 1080x1920 box
      assert.strictEqual(result.eligible.length, 3);
      assert.strictEqual(result.skipped[0]?.profile, '1080p');
      assert.strictEqual(result.skipped[0]?.reason, 'SOURCE_ALREADY_WITHIN_PROFILE');
    });
  });

  describe('8. Part A Policy Correction Regression Requirements', () => {
    it('1000x1000 source against 1080p: skip (SOURCE_ALREADY_WITHIN_PROFILE)', () => {
      const result = resolveTranscodingProfiles({
        source: { width: 1000, height: 1000 },
        config: { profiles: ['1080p'] },
      });

      assert.strictEqual(result.eligible.length, 0);
      assert.strictEqual(result.skipped.length, 1);
      assert.strictEqual(result.skipped[0]?.profile, '1080p');
      assert.strictEqual(result.skipped[0]?.reason, 'SOURCE_ALREADY_WITHIN_PROFILE');
    });

    it('1000x1000 source against 720p: generate 720x720', () => {
      const result = resolveTranscodingProfiles({
        source: { width: 1000, height: 1000 },
        config: { profiles: ['720p'] },
      });

      assert.strictEqual(result.eligible.length, 1);
      assert.strictEqual(result.skipped.length, 0);
      assert.strictEqual(result.eligible[0]?.profile, '720p');
      assert.strictEqual(result.eligible[0]?.targetWidth, 720);
      assert.strictEqual(result.eligible[0]?.targetHeight, 720);
    });

    it('1000x1000 automatic resolution: generates 720p, 480p, 360p and skips 1080p', () => {
      const result = resolveTranscodingProfiles({
        source: { width: 1000, height: 1000 },
      });

      assert.strictEqual(result.eligible.length, 3);
      assert.deepStrictEqual(result.eligible.map((e) => e.profile), ['360p', '480p', '720p']);

      // 360p -> 360x360
      assert.strictEqual(result.eligible[0]?.targetWidth, 360);
      assert.strictEqual(result.eligible[0]?.targetHeight, 360);
      // 480p -> 480x480
      assert.strictEqual(result.eligible[1]?.targetWidth, 480);
      assert.strictEqual(result.eligible[1]?.targetHeight, 480);
      // 720p -> 720x720
      assert.strictEqual(result.eligible[2]?.targetWidth, 720);
      assert.strictEqual(result.eligible[2]?.targetHeight, 720);

      assert.strictEqual(result.skipped.length, 1);
      assert.strictEqual(result.skipped[0]?.profile, '1080p');
      assert.strictEqual(result.skipped[0]?.reason, 'SOURCE_ALREADY_WITHIN_PROFILE');
    });

    it('1919x1079 source against 1080p: skip (SOURCE_ALREADY_WITHIN_PROFILE)', () => {
      const result = resolveTranscodingProfiles({
        source: { width: 1919, height: 1079 },
        config: { profiles: ['1080p'] },
      });

      assert.strictEqual(result.eligible.length, 0);
      assert.strictEqual(result.skipped.length, 1);
      assert.strictEqual(result.skipped[0]?.profile, '1080p');
      assert.strictEqual(result.skipped[0]?.reason, 'SOURCE_ALREADY_WITHIN_PROFILE');
    });

    it('1920x1080 source against 1080p: skip (SOURCE_ALREADY_WITHIN_PROFILE)', () => {
      const result = resolveTranscodingProfiles({
        source: { width: 1920, height: 1080 },
        config: { profiles: ['1080p'] },
      });

      assert.strictEqual(result.eligible.length, 0);
      assert.strictEqual(result.skipped.length, 1);
      assert.strictEqual(result.skipped[0]?.profile, '1080p');
      assert.strictEqual(result.skipped[0]?.reason, 'SOURCE_ALREADY_WITHIN_PROFILE');
    });
  });

  describe('9. Unusual Aspect Ratios & Non-16:9 Sources', () => {
    it('preserves aspect ratio for 4:3 SD source (1440x1080): skips 1080p and generates downscaled renditions', () => {
      const result = resolveTranscodingProfiles({
        source: { width: 1440, height: 1080 },
      });

      // 1440x1080 fits within 1080p box (1920x1080) -> skip
      assert.strictEqual(result.eligible.length, 3);
      assert.deepStrictEqual(result.eligible.map((e) => e.profile), ['360p', '480p', '720p']);
      assert.strictEqual(result.skipped[0]?.profile, '1080p');
      assert.strictEqual(result.skipped[0]?.reason, 'SOURCE_ALREADY_WITHIN_PROFILE');

      // 360p: height limited to 360, width 480 (4:3)
      const p360 = result.eligible.find((e) => e.profile === '360p')!;
      assert.strictEqual(p360.targetWidth, 480);
      assert.strictEqual(p360.targetHeight, 360);

      // 480p: height limited to 480, width 640 (4:3)
      const p480 = result.eligible.find((e) => e.profile === '480p')!;
      assert.strictEqual(p480.targetWidth, 640);
      assert.strictEqual(p480.targetHeight, 480);

      // 720p: height limited to 720, width 960 (4:3)
      const p720 = result.eligible.find((e) => e.profile === '720p')!;
      assert.strictEqual(p720.targetWidth, 960);
      assert.strictEqual(p720.targetHeight, 720);
    });

    it('preserves aspect ratio for 2.39:1 Cinemascope source (1920x804): skips 1080p and generates 720p, 480p, 360p', () => {
      const result = resolveTranscodingProfiles({
        source: { width: 1920, height: 804 },
      });

      // 1920x804 fits in 1080p box (1920x1080) -> skip
      assert.strictEqual(result.eligible.length, 3);
      assert.deepStrictEqual(result.eligible.map((e) => e.profile), ['360p', '480p', '720p']);
      assert.strictEqual(result.skipped[0]?.profile, '1080p');
      assert.strictEqual(result.skipped[0]?.reason, 'SOURCE_ALREADY_WITHIN_PROFILE');

      // 720p box 1280x720: width limited to 1280, height 536
      const p720 = result.eligible.find((e) => e.profile === '720p')!;
      assert.strictEqual(p720.targetWidth, 1280);
      assert.strictEqual(p720.targetHeight, 536);
    });

    it('preserves aspect ratio for 1:1 Square video (1080x1080): skips 1080p and generates downscaled', () => {
      const result = resolveTranscodingProfiles({
        source: { width: 1080, height: 1080 },
      });

      // 1080x1080 fits in 1080p box (1920x1080) -> skip
      assert.strictEqual(result.eligible.length, 3);
      assert.deepStrictEqual(result.eligible.map((e) => e.profile), ['360p', '480p', '720p']);
      assert.strictEqual(result.skipped[0]?.profile, '1080p');
      assert.strictEqual(result.skipped[0]?.reason, 'SOURCE_ALREADY_WITHIN_PROFILE');

      // 360p box 640x360: height limited to 360 -> 360x360
      assert.strictEqual(result.eligible[0]?.targetWidth, 360);
      assert.strictEqual(result.eligible[0]?.targetHeight, 360);

      // 480p box 854x480: height limited to 480 -> 480x480
      assert.strictEqual(result.eligible[1]?.targetWidth, 480);
      assert.strictEqual(result.eligible[1]?.targetHeight, 480);

      // 720p box 1280x720: height limited to 720 -> 720x720
      assert.strictEqual(result.eligible[2]?.targetWidth, 720);
      assert.strictEqual(result.eligible[2]?.targetHeight, 720);
    });

    it('skips all profiles for 360x360 square video because it already fits inside all bounding boxes', () => {
      const result = resolveTranscodingProfiles({
        source: { width: 360, height: 360 },
      });

      assert.strictEqual(result.eligible.length, 0);
      assert.strictEqual(result.skipped.length, 4);
      assert.ok(result.skipped.every((s) => s.reason === 'SOURCE_ALREADY_WITHIN_PROFILE'));
    });
  });

  describe('10. Odd-Dimension Regression & Boundary Invariants', () => {
    describe('floorToEven helper unit tests', () => {
      it('preserves positive even integers', () => {
        assert.strictEqual(floorToEven(2), 2);
        assert.strictEqual(floorToEven(640), 640);
        assert.strictEqual(floorToEven(854), 854);
        assert.strictEqual(floorToEven(1080), 1080);
        assert.strictEqual(floorToEven(1920), 1920);
      });

      it('floors positive odd integers to preceding even integer', () => {
        assert.strictEqual(floorToEven(3), 2);
        assert.strictEqual(floorToEven(7), 6);
        assert.strictEqual(floorToEven(855), 854);
        assert.strictEqual(floorToEven(1081), 1080);
        assert.strictEqual(floorToEven(1921), 1920);
      });

      it('floors fractional values down to largest even integer', () => {
        assert.strictEqual(floorToEven(853.333), 852);
        assert.strictEqual(floorToEven(853.999), 852);
        assert.strictEqual(floorToEven(854.001), 854);
        assert.strictEqual(floorToEven(855.9), 854);
      });

      it('enforces minimum dimension of 2 for values <= 2', () => {
        assert.strictEqual(floorToEven(1), 2);
        assert.strictEqual(floorToEven(0), 2);
        assert.strictEqual(floorToEven(-4), 2);
      });
    });

    describe('Odd-dimension resolution correctness and boundary invariants', () => {
      it('handles odd 4K source (3841x2161) without exceeding source or profile bounds', () => {
        const result = resolveTranscodingProfiles({
          source: { width: 3841, height: 2161 },
        });

        assert.strictEqual(result.eligible.length, 4);
        for (const el of result.eligible) {
          const profileDef = SUPPORTED_PROFILES[el.profile];
          assert.strictEqual(el.targetWidth % 2, 0, `${el.profile} targetWidth must be even`);
          assert.strictEqual(el.targetHeight % 2, 0, `${el.profile} targetHeight must be even`);
          assert.ok(el.targetWidth <= 3841, `${el.profile} targetWidth must not exceed source width`);
          assert.ok(el.targetHeight <= 2161, `${el.profile} targetHeight must not exceed source height`);
          assert.ok(el.targetWidth <= profileDef.maxWidth, `${el.profile} targetWidth must not exceed box maxWidth`);
          assert.ok(el.targetHeight <= profileDef.maxHeight, `${el.profile} targetHeight must not exceed box maxHeight`);
          assert.ok(el.targetWidth >= 2, `${el.profile} targetWidth must be >= 2`);
          assert.ok(el.targetHeight >= 2, `${el.profile} targetHeight must be >= 2`);
        }
      });

      it('handles odd 1080p source (1921x1081): 1921 > 1920 and 1081 > 1080, so 1080p reduces dimensions', () => {
        const result = resolveTranscodingProfiles({
          source: { width: 1921, height: 1081 },
        });

        assert.strictEqual(result.eligible.length, 4);
        for (const el of result.eligible) {
          const profileDef = SUPPORTED_PROFILES[el.profile];
          assert.strictEqual(el.targetWidth % 2, 0);
          assert.strictEqual(el.targetHeight % 2, 0);
          assert.ok(el.targetWidth <= 1921);
          assert.ok(el.targetHeight <= 1081);
          assert.ok(el.targetWidth <= profileDef.maxWidth);
          assert.ok(el.targetHeight <= profileDef.maxHeight);
        }
      });

      it('handles odd 720p source (1281x721): does not fit in 720p box, generates 720p, 480p, 360p and skips 1080p', () => {
        const result = resolveTranscodingProfiles({
          source: { width: 1281, height: 721 },
        });

        // 1281x721 fits inside 1080p box (1920x1080) -> 1080p skipped (SOURCE_ALREADY_WITHIN_PROFILE)
        // Does not fit inside 720p box (1280x720) -> 720p, 480p, 360p eligible
        assert.strictEqual(result.eligible.length, 3);
        assert.deepStrictEqual(result.eligible.map((e) => e.profile), ['360p', '480p', '720p']);
        assert.strictEqual(result.skipped.length, 1);
        assert.strictEqual(result.skipped[0]?.profile, '1080p');
        assert.strictEqual(result.skipped[0]?.reason, 'SOURCE_ALREADY_WITHIN_PROFILE');

        for (const el of result.eligible) {
          const profileDef = SUPPORTED_PROFILES[el.profile];
          assert.strictEqual(el.targetWidth % 2, 0);
          assert.strictEqual(el.targetHeight % 2, 0);
          assert.ok(el.targetWidth <= 1281);
          assert.ok(el.targetHeight <= 721);
          assert.ok(el.targetWidth <= profileDef.maxWidth);
          assert.ok(el.targetHeight <= profileDef.maxHeight);
        }
      });

      it('exhaustively verifies dimension invariants across arbitrary dimension matrix', () => {
        const testDimensions: Array<{ width: number; height: number; rotation?: number }> = [
          { width: 3840, height: 2160 },
          { width: 1921, height: 1081 },
          { width: 1919, height: 1079 },
          { width: 1365, height: 767 },
          { width: 1281, height: 721 },
          { width: 1000, height: 1000 },
          { width: 855, height: 481 },
          { width: 641, height: 361 },
          { width: 2161, height: 3841 }, // 4K portrait
          { width: 1081, height: 1921 }, // portrait
          { width: 721, height: 1281 },  // portrait
          { width: 1921, height: 1081, rotation: 90 }, // rotation
          { width: 1921, height: 805 },  // ultrawide
          { width: 1439, height: 1079 }, // 4:3
          { width: 7, height: 5 },       // tiny odd dimensions
        ];

        for (const source of testDimensions) {
          const res = resolveTranscodingProfiles({ source });
          const { effectiveWidth, effectiveHeight, isPortrait } = res.sourceNormalized;

          for (const el of res.eligible) {
            const profile = SUPPORTED_PROFILES[el.profile];
            const boxWidth = isPortrait ? profile.maxHeight : profile.maxWidth;
            const boxHeight = isPortrait ? profile.maxWidth : profile.maxHeight;

            // Invariant 1: Strictly even integers
            assert.strictEqual(
              el.targetWidth % 2,
              0,
              `targetWidth ${el.targetWidth} must be even for ${source.width}x${source.height} [${el.profile}]`
            );
            assert.strictEqual(
              el.targetHeight % 2,
              0,
              `targetHeight ${el.targetHeight} must be even for ${source.width}x${source.height} [${el.profile}]`
            );

            // Invariant 2: At least 2 pixels
            assert.ok(
              el.targetWidth >= 2,
              `targetWidth ${el.targetWidth} must be >= 2 for ${source.width}x${source.height} [${el.profile}]`
            );
            assert.ok(
              el.targetHeight >= 2,
              `targetHeight ${el.targetHeight} must be >= 2 for ${source.width}x${source.height} [${el.profile}]`
            );

            // Invariant 3: Never exceeds effective source dimensions
            assert.ok(
              el.targetWidth <= effectiveWidth,
              `targetWidth ${el.targetWidth} exceeds effectiveWidth ${effectiveWidth} for [${el.profile}]`
            );
            assert.ok(
              el.targetHeight <= effectiveHeight,
              `targetHeight ${el.targetHeight} exceeds effectiveHeight ${effectiveHeight} for [${el.profile}]`
            );

            // Invariant 4: Never exceeds profile bounding box
            assert.ok(
              el.targetWidth <= boxWidth,
              `targetWidth ${el.targetWidth} exceeds boxWidth ${boxWidth} for [${el.profile}]`
            );
            assert.ok(
              el.targetHeight <= boxHeight,
              `targetHeight ${el.targetHeight} exceeds boxHeight ${boxHeight} for [${el.profile}]`
            );

            // Invariant 5: Must strictly reduce effective source dimensions
            assert.ok(
              el.targetWidth < effectiveWidth || el.targetHeight < effectiveHeight,
              `target ${el.targetWidth}x${el.targetHeight} does not reduce source ${effectiveWidth}x${effectiveHeight} for [${el.profile}]`
            );
          }

          for (const sk of res.skipped) {
            assert.ok(
              sk.reason === 'SOURCE_ALREADY_WITHIN_PROFILE' || sk.reason === 'SOURCE_RESOLUTION_TOO_LOW',
              `Unknown skip reason: ${sk.reason}`
            );
          }
        }
      });
    });
  });
});
