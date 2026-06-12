//! Receiver DSP: biquad filters, the RIAA de-emphasis curve for phono input,
//! and the bass/treble tone stack. Runs on the line-in relay thread — never
//! on the realtime output callback. Coefficients are computed in f64 and the
//! per-sample path is branch-light f32.

/// Direct Form II transposed biquad.
#[derive(Debug, Clone, Copy)]
pub struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    /// Build from f64 polynomial coefficients, normalizing by a[0].
    fn from_f64(b: [f64; 3], a: [f64; 3]) -> Self {
        let a0 = a[0];
        Self {
            b0: (b[0] / a0) as f32,
            b1: (b[1] / a0) as f32,
            b2: (b[2] / a0) as f32,
            a1: (a[1] / a0) as f32,
            a2: (a[2] / a0) as f32,
            z1: 0.0,
            z2: 0.0,
        }
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }

    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }

    /// |H(e^jω)| at `freq` — used for tests and gain normalization.
    pub fn magnitude_at(&self, freq: f64, sample_rate: f64) -> f64 {
        let w = 2.0 * std::f64::consts::PI * freq / sample_rate;
        // Evaluate numerator and denominator at z⁻¹ = e^{-jw}.
        let eval = |c0: f64, c1: f64, c2: f64| -> (f64, f64) {
            let (re1, im1) = (w.cos(), -w.sin());
            let (re2, im2) = ((2.0 * w).cos(), -(2.0 * w).sin());
            (c0 + c1 * re1 + c2 * re2, c1 * im1 + c2 * im2)
        };
        let (nr, ni) = eval(self.b0 as f64, self.b1 as f64, self.b2 as f64);
        let (dr, di) = eval(1.0, self.a1 as f64, self.a2 as f64);
        ((nr * nr + ni * ni) / (dr * dr + di * di)).sqrt()
    }

    fn scale_gain(&mut self, factor: f64) {
        self.b0 = (self.b0 as f64 * factor) as f32;
        self.b1 = (self.b1 as f64 * factor) as f32;
        self.b2 = (self.b2 as f64 * factor) as f32;
    }
}

const RIAA_T1: f64 = 75e-6;
const RIAA_T2: f64 = 318e-6;
const RIAA_T3: f64 = 3180e-6;

/// Ideal analog RIAA playback magnitude relative to 1 kHz, in dB.
fn riaa_analog_db(freq: f64) -> f64 {
    let mag = |f: f64| -> f64 {
        let w = 2.0 * std::f64::consts::PI * f;
        let num = (1.0 + (w * RIAA_T2).powi(2)).sqrt();
        let den = ((1.0 + (w * RIAA_T1).powi(2)) * (1.0 + (w * RIAA_T3).powi(2))).sqrt();
        num / den
    };
    20.0 * (mag(freq) / mag(1000.0)).log10()
}

fn riaa_with_zero(sample_rate: u32, c: f64) -> Biquad {
    let k = 2.0 * sample_rate as f64;
    // Each analog first-order factor (T·s + 1) maps to (TK+1) + (1−TK)·z⁻¹
    // by the bilinear transform; the numerator gets an extra tunable zero
    // (1 + c·z⁻¹) to match the denominator order.
    let n0 = RIAA_T2 * k + 1.0;
    let n1 = 1.0 - RIAA_T2 * k;
    let b = [n0, n0 * c + n1, n1 * c];

    let p10 = RIAA_T1 * k + 1.0;
    let p11 = 1.0 - RIAA_T1 * k;
    let p30 = RIAA_T3 * k + 1.0;
    let p31 = 1.0 - RIAA_T3 * k;
    let a = [p10 * p30, p10 * p31 + p11 * p30, p11 * p31];

    let mut bi = Biquad::from_f64(b, a);
    let gain_1k = bi.magnitude_at(1000.0, sample_rate as f64);
    bi.scale_gain(1.0 / gain_1k);
    bi
}

/// RIAA playback de-emphasis (inverse of the cutting pre-emphasis), unity
/// gain at 1 kHz. Standard time constants 75 µs / 318 µs / 3180 µs mapped
/// with the bilinear transform; a plain transform droops ~1.6 dB at 10 kHz
/// for 44.1 kHz output, so the extra numerator zero is grid-searched once
/// at construction to minimize the worst-case error against the analog
/// curve (≤ ~0.32 dB across 20 Hz – 20 kHz at common rates).
pub fn riaa_playback(sample_rate: u32) -> Biquad {
    let reference = [
        20.0, 50.0, 100.0, 500.0, 1000.0, 2000.0, 5000.0, 10_000.0, 15_000.0, 20_000.0,
    ];
    let limit = sample_rate as f64 / 2.0 * 0.95;
    let mut best = (0.0f64, f64::INFINITY);
    for step in 0..=1000 {
        let c = step as f64 / 1000.0;
        let candidate = riaa_with_zero(sample_rate, c);
        let mut worst = 0.0f64;
        for &freq in reference.iter().filter(|&&f| f < limit) {
            let got = 20.0 * candidate.magnitude_at(freq, sample_rate as f64).log10();
            worst = worst.max((got - riaa_analog_db(freq)).abs());
        }
        if worst < best.1 {
            best = (c, worst);
        }
    }
    riaa_with_zero(sample_rate, best.0)
}

/// RBJ cookbook low shelf (bass control), shelf slope S = 1.
pub fn low_shelf(sample_rate: u32, freq: f64, gain_db: f64) -> Biquad {
    shelf(sample_rate, freq, gain_db, true)
}

/// RBJ cookbook high shelf (treble control), shelf slope S = 1.
pub fn high_shelf(sample_rate: u32, freq: f64, gain_db: f64) -> Biquad {
    shelf(sample_rate, freq, gain_db, false)
}

fn shelf(sample_rate: u32, freq: f64, gain_db: f64, low: bool) -> Biquad {
    let a = 10f64.powf(gain_db / 40.0);
    let w0 = 2.0 * std::f64::consts::PI * freq / sample_rate as f64;
    let (sin, cos) = (w0.sin(), w0.cos());
    // RBJ: alpha = sin/2 · sqrt((A + 1/A)(1/S − 1) + 2); with slope S = 1 the
    // first term vanishes.
    let alpha = sin / 2.0 * 2.0f64.sqrt();
    let two_sqrt_a_alpha = 2.0 * a.sqrt() * alpha;

    let (b, ad) = if low {
        (
            [
                a * ((a + 1.0) - (a - 1.0) * cos + two_sqrt_a_alpha),
                2.0 * a * ((a - 1.0) - (a + 1.0) * cos),
                a * ((a + 1.0) - (a - 1.0) * cos - two_sqrt_a_alpha),
            ],
            [
                (a + 1.0) + (a - 1.0) * cos + two_sqrt_a_alpha,
                -2.0 * ((a - 1.0) + (a + 1.0) * cos),
                (a + 1.0) + (a - 1.0) * cos - two_sqrt_a_alpha,
            ],
        )
    } else {
        (
            [
                a * ((a + 1.0) + (a - 1.0) * cos + two_sqrt_a_alpha),
                -2.0 * a * ((a - 1.0) + (a + 1.0) * cos),
                a * ((a + 1.0) + (a - 1.0) * cos - two_sqrt_a_alpha),
            ],
            [
                (a + 1.0) - (a - 1.0) * cos + two_sqrt_a_alpha,
                2.0 * ((a - 1.0) - (a + 1.0) * cos),
                (a + 1.0) - (a - 1.0) * cos - two_sqrt_a_alpha,
            ],
        )
    };
    Biquad::from_f64(b, ad)
}

pub const BASS_SHELF_HZ: f64 = 120.0;
pub const TREBLE_SHELF_HZ: f64 = 8000.0;
pub const TONE_RANGE_DB: f32 = 12.0;

/// Current receiver DSP settings.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DspParams {
    pub riaa: bool,
    pub bass_db: f32,
    pub treble_db: f32,
}

impl Default for DspParams {
    fn default() -> Self {
        Self {
            riaa: false,
            bass_db: 0.0,
            treble_db: 0.0,
        }
    }
}

/// Stereo processing chain: RIAA (optional) → bass shelf → treble shelf.
pub struct DspChain {
    sample_rate: u32,
    params: DspParams,
    riaa_l: Biquad,
    riaa_r: Biquad,
    bass_l: Biquad,
    bass_r: Biquad,
    treble_l: Biquad,
    treble_r: Biquad,
}

impl DspChain {
    pub fn new(sample_rate: u32) -> Self {
        let params = DspParams::default();
        let mut chain = Self {
            sample_rate,
            params,
            riaa_l: riaa_playback(sample_rate),
            riaa_r: riaa_playback(sample_rate),
            bass_l: low_shelf(sample_rate, BASS_SHELF_HZ, 0.0),
            bass_r: low_shelf(sample_rate, BASS_SHELF_HZ, 0.0),
            treble_l: high_shelf(sample_rate, TREBLE_SHELF_HZ, 0.0),
            treble_r: high_shelf(sample_rate, TREBLE_SHELF_HZ, 0.0),
        };
        chain.set_params(params);
        chain
    }

    /// Recompute coefficients when the settings change. Filter state is kept
    /// so a toggle mid-stream doesn't click any harder than necessary.
    pub fn set_params(&mut self, params: DspParams) {
        if params.bass_db != self.params.bass_db {
            let bass = clamp_db(params.bass_db);
            self.bass_l = low_shelf(self.sample_rate, BASS_SHELF_HZ, bass as f64);
            self.bass_r = low_shelf(self.sample_rate, BASS_SHELF_HZ, bass as f64);
        }
        if params.treble_db != self.params.treble_db {
            let treble = clamp_db(params.treble_db);
            self.treble_l = high_shelf(self.sample_rate, TREBLE_SHELF_HZ, treble as f64);
            self.treble_r = high_shelf(self.sample_rate, TREBLE_SHELF_HZ, treble as f64);
        }
        if params.riaa && !self.params.riaa {
            self.riaa_l.reset();
            self.riaa_r.reset();
        }
        self.params = params;
    }

    pub fn params(&self) -> DspParams {
        self.params
    }

    #[inline]
    pub fn process(&mut self, l: &mut f32, r: &mut f32) {
        if self.params.riaa {
            *l = self.riaa_l.process(*l);
            *r = self.riaa_r.process(*r);
        }
        if self.params.bass_db != 0.0 {
            *l = self.bass_l.process(*l);
            *r = self.bass_r.process(*r);
        }
        if self.params.treble_db != 0.0 {
            *l = self.treble_l.process(*l);
            *r = self.treble_r.process(*r);
        }
    }
}

fn clamp_db(db: f32) -> f32 {
    db.clamp(-TONE_RANGE_DB, TONE_RANGE_DB)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db(mag: f64) -> f64 {
        20.0 * mag.log10()
    }

    /// Standard RIAA playback response relative to 1 kHz.
    #[test]
    fn riaa_matches_reference_points() {
        for rate in [44_100u32, 48_000, 96_000] {
            let f = riaa_playback(rate);
            let fr = rate as f64;
            assert!(
                (db(f.magnitude_at(1000.0, fr))).abs() < 0.01,
                "1 kHz must be unity at {rate} Hz"
            );
            let cases = [
                (20.0, 19.27),
                (100.0, 13.09),
                (1000.0, 0.0),
                (10_000.0, -13.73),
            ];
            for (freq, expected) in cases {
                let got = db(f.magnitude_at(freq, fr));
                assert!(
                    (got - expected).abs() < 0.5,
                    "RIAA at {freq} Hz / {rate}: expected {expected} dB, got {got:.2} dB"
                );
            }
        }
    }

    #[test]
    fn shelves_boost_their_band_and_leave_the_other_alone() {
        let rate = 48_000u32;
        let bass = low_shelf(rate, BASS_SHELF_HZ, 6.0);
        assert!((db(bass.magnitude_at(20.0, rate as f64)) - 6.0).abs() < 0.5);
        assert!(db(bass.magnitude_at(8000.0, rate as f64)).abs() < 0.3);

        let treble = high_shelf(rate, TREBLE_SHELF_HZ, -6.0);
        assert!((db(treble.magnitude_at(20_000.0, rate as f64)) + 6.0).abs() < 0.6);
        assert!(db(treble.magnitude_at(100.0, rate as f64)).abs() < 0.3);
    }

    #[test]
    fn flat_chain_is_a_passthrough() {
        let mut chain = DspChain::new(48_000);
        let samples: Vec<f32> = (0..480).map(|i| (i as f32 * 0.013).sin() * 0.5).collect();
        for &s in &samples {
            let (mut l, mut r) = (s, -s);
            chain.process(&mut l, &mut r);
            assert_eq!(l, s, "flat chain must not alter the left channel");
            assert_eq!(r, -s, "flat chain must not alter the right channel");
        }
    }

    #[test]
    fn riaa_chain_boosts_bass_and_cuts_treble() {
        let rate = 48_000u32;
        let mut chain = DspChain::new(rate);
        chain.set_params(DspParams {
            riaa: true,
            bass_db: 0.0,
            treble_db: 0.0,
        });

        // Measure steady-state RMS gain of a low and a high frequency tone.
        let gain_of = |chain: &mut DspChain, freq: f32| -> f32 {
            let n = rate as usize; // one second
            let mut in_acc = 0f64;
            let mut out_acc = 0f64;
            for i in 0..n {
                let x =
                    (2.0 * std::f32::consts::PI * freq * i as f32 / rate as f32).sin() * 0.25;
                let (mut l, mut r) = (x, x);
                chain.process(&mut l, &mut r);
                // skip the first quarter second of transient
                if i > n / 4 {
                    in_acc += (x * x) as f64;
                    out_acc += (l * l) as f64;
                }
            }
            (out_acc / in_acc).sqrt() as f32
        };

        let low = gain_of(&mut chain, 50.0);
        assert!(low > 4.0, "RIAA should boost 50 Hz strongly, gain {low}");
        chain.set_params(DspParams {
            riaa: true,
            bass_db: 0.0,
            treble_db: 0.0,
        });
        let high = gain_of(&mut chain, 10_000.0);
        assert!(high < 0.3, "RIAA should cut 10 kHz strongly, gain {high}");
    }
}
