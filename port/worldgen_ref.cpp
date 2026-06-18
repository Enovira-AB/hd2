// Bit-exact C++ reference port of shared/world.ts — the deterministic world
// generator. Proves the port contract (ios/PORTING.md) holds in a compiled,
// statically-typed language: the integer RNG path matches EXACTLY; positions
// derived through cos/sin/hypot match within 1e-6 (transcendental functions can
// differ by a ULP across math libraries, which is harmless — the server stays
// authoritative on positions).
//
// This same logic is a 1:1 translation to C# (Unity) — only syntax changes.
//
// Build & verify:  g++ -O2 -std=c++17 port/worldgen_ref.cpp -o /tmp/wg \
//                  && /tmp/wg port/worldgen_fixture.txt

#include <cstdint>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>
#include <fstream>

static const double MAP_HALF = 110.0;

// --- bit-exact integer RNG / hashing (must match JS exactly) ------------------

// JS: a = (a + 0x6d2b79f5) >>> 0; t = imul(t^(t>>>15), t|1);
//     t ^= t + imul(t^(t>>>7), t|61); return ((t^(t>>>14))>>>0) / 2^32
struct Mulberry32 {
  uint32_t a;
  explicit Mulberry32(uint32_t seed) : a(seed) {}
  double operator()() {
    a = a + 0x6d2b79f5u;                       // uint32 wraparound
    uint32_t t = a;
    t = (uint32_t)((int32_t)(t ^ (t >> 15)) * (int32_t)(t | 1u));   // Math.imul
    t ^= t + (uint32_t)((int32_t)(t ^ (t >> 7)) * (int32_t)(t | 61u));
    return (double)(t ^ (t >> 14)) / 4294967296.0;
  }
};

static double hash2(uint32_t seed, int32_t ix, int32_t iz) {
  int32_t h = (int32_t)seed ^ (int32_t)((int32_t)ix * 374761393)
                            ^ (int32_t)((int32_t)iz * 668265263);   // | 0
  h = (int32_t)((int32_t)(h ^ (int32_t)((uint32_t)h >> 13)) * 1274126177);
  uint32_t u = (uint32_t)h;
  return (double)(u ^ (u >> 16)) / 4294967296.0;
}

static double smoothstep(double t) { return t * t * (3.0 - 2.0 * t); }

static double valueNoise(uint32_t seed, double x, double z) {
  int32_t ix = (int32_t)std::floor(x);
  int32_t iz = (int32_t)std::floor(z);
  double fx = smoothstep(x - ix);
  double fz = smoothstep(z - iz);
  double a = hash2(seed, ix, iz);
  double b = hash2(seed, ix + 1, iz);
  double c = hash2(seed, ix, iz + 1);
  double d = hash2(seed, ix + 1, iz + 1);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

static double flatten(double x, double z, double cx, double cz, double r) {
  double d = std::hypot(x - cx, z - cz);
  if (d >= r + 16) return 1.0;
  if (d <= r) return 0.0;
  return smoothstep((d - r) / 16.0);
}

struct Vec2 { double x, z; };
struct Rock { double x, z, r, h; };

static Vec2 padPosition(uint32_t seed) {
  Mulberry32 rng(seed ^ 0x5addu);
  double ang = rng() * M_PI * 2.0;
  double dist = 62.0 + rng() * 18.0;
  return { std::cos(ang) * dist, std::sin(ang) * dist };
}

static double terrainHeight(uint32_t seed, double x, double z) {
  double h = valueNoise(seed, x * 0.02 + 100, z * 0.02 + 100) * 5.0;
  h += valueNoise(seed ^ 0x9e37u, x * 0.055 + 100, z * 0.055 + 100) * 1.4;
  h += valueNoise(seed ^ 0x51abu, x * 0.16 + 100, z * 0.16 + 100) * 0.35;
  Vec2 pad = padPosition(seed);
  h *= flatten(x, z, 0, 0, 9);
  h *= flatten(x, z, pad.x, pad.z, 10);
  return h;
}

struct Layout { Vec2 pad; std::vector<Rock> rocks; std::vector<Vec2> nests; };

static Layout generateLayout(uint32_t seed) {
  Vec2 pad = padPosition(seed);
  Mulberry32 rng(seed ^ 0x70c5u);
  Layout L; L.pad = pad;
  for (int i = 0; i < 140 && (int)L.rocks.size() < 95; i++) {
    double x = (rng() * 2 - 1) * (MAP_HALF - 6);
    double z = (rng() * 2 - 1) * (MAP_HALF - 6);
    double r = 1.1 + rng() * 2.6;
    if (std::hypot(x, z) < 14 + r) continue;
    if (std::hypot(x - pad.x, z - pad.z) < 13 + r) continue;
    L.rocks.push_back({ x, z, r, r * (1.0 + rng() * 0.9) });
  }
  for (int i = 0; i < 40 && (int)L.nests.size() < 5; i++) {
    double ang = rng() * M_PI * 2.0;
    double dist = 52.0 + rng() * 42.0;
    double x = std::cos(ang) * dist;
    double z = std::sin(ang) * dist;
    if (std::fabs(x) > MAP_HALF - 8 || std::fabs(z) > MAP_HALF - 8) continue;
    if (std::hypot(x - pad.x, z - pad.z) < 30) continue;
    bool tooClose = false;
    for (auto& n : L.nests) if (std::hypot(n.x - x, n.z - z) < 34) { tooClose = true; break; }
    if (tooClose) continue;
    L.nests.push_back({ x, z });
  }
  return L;
}

// --- verifier against the TS fixture -----------------------------------------

int main(int argc, char** argv) {
  if (argc < 2) { std::fprintf(stderr, "usage: %s fixture.txt\n", argv[0]); return 2; }
  std::ifstream in(argv[1]);
  if (!in) { std::fprintf(stderr, "cannot open %s\n", argv[1]); return 2; }

  const double EPS = 1e-6;
  int exactFails = 0, epsFails = 0, countFails = 0, checks = 0;
  auto eps = [&](double a, double b, const char* what) {
    checks++;
    if (std::fabs(a - b) > EPS) { epsFails++; std::printf("  EPS  %s: %.10f vs %.10f\n", what, a, b); }
  };

  std::string tok;
  while (in >> tok) {
    if (tok == "RNG") {
      uint32_t seed; int n; in >> seed >> n;
      Mulberry32 rng(seed);
      for (int i = 0; i < n; i++) {
        double want; in >> want; double got = rng(); checks++;
        if (got != want) { exactFails++; std::printf("  RNG[%d] EXACT FAIL: %.17g vs %.17g\n", i, got, want); }
      }
    } else if (tok == "WORLD") {
      uint32_t seed; in >> seed;
      std::string t; in >> t; // PAD
      double px, pz; in >> px >> pz;
      Vec2 pad = padPosition(seed);
      eps(pad.x, px, "pad.x"); eps(pad.z, pz, "pad.z");
      in >> t; int hc; in >> hc; // HEIGHTS n
      for (int i = 0; i < hc; i++) { double x, z, h; in >> x >> z >> h; eps(terrainHeight(seed, x, z), h, "height"); }
      Layout L = generateLayout(seed);
      in >> t; int rc; in >> rc; // ROCKS n
      if ((int)L.rocks.size() != rc) { countFails++; std::printf("  COUNT rocks seed %u: %zu vs %d\n", seed, L.rocks.size(), rc); }
      for (int i = 0; i < rc; i++) { double x, z, r, h; in >> x >> z >> r >> h;
        if (i < (int)L.rocks.size()) { eps(L.rocks[i].x, x, "rock.x"); eps(L.rocks[i].z, z, "rock.z"); eps(L.rocks[i].r, r, "rock.r"); eps(L.rocks[i].h, h, "rock.h"); } }
      in >> t; int nc; in >> nc; // NESTS n
      if ((int)L.nests.size() != nc) { countFails++; std::printf("  COUNT nests seed %u: %zu vs %d\n", seed, L.nests.size(), nc); }
      for (int i = 0; i < nc; i++) { double x, z; in >> x >> z;
        if (i < (int)L.nests.size()) { eps(L.nests[i].x, x, "nest.x"); eps(L.nests[i].z, z, "nest.z"); } }
    }
  }

  std::printf("\n%d checks — exact RNG fails: %d, epsilon fails: %d, count fails: %d\n",
              checks, exactFails, epsFails, countFails);
  if (exactFails || epsFails || countFails) { std::printf("WORLDGEN PORT MISMATCH\n"); return 1; }
  std::printf("WORLDGEN PORT VERIFIED — C++ reproduces the TS world bit-for-bit (RNG exact, positions < 1e-6)\n");
  return 0;
}
