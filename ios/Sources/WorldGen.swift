// Bit-exact port of shared/world.ts. The server, the web client and this
// file MUST produce identical terrain, rocks and layout from the same seed.
//
// Porting rules (see ios/PORTING.md):
//  - JS `Math.imul(a, b)`  → Swift `Int32 &* Int32`
//  - JS `x >>> n`          → Swift logical shift on UInt32
//  - JS `x | 0` / `^`      → 32-bit wrapping semantics (UInt32/Int32 bitPattern)
//  - JS float `+` followed by a bitwise op coerces via ToInt32 → `&+` on UInt32

import Foundation

func mulberry32(_ seed: UInt32) -> () -> Double {
    var a = seed
    return {
        a = a &+ 0x6D2B79F5
        var t = a
        t = UInt32(bitPattern: Int32(bitPattern: t ^ (t >> 15)) &* Int32(bitPattern: t | 1))
        t ^= t &+ UInt32(bitPattern: Int32(bitPattern: t ^ (t >> 7)) &* Int32(bitPattern: t | 61))
        return Double(t ^ (t >> 14)) / 4294967296.0
    }
}

private func hash2(_ seed: UInt32, _ ix: Int32, _ iz: Int32) -> Double {
    var h = Int32(bitPattern: seed) ^ (ix &* 374761393) ^ (iz &* 668265263)
    h = (h ^ Int32(bitPattern: UInt32(bitPattern: h) >> 13)) &* 1274126177
    let u = UInt32(bitPattern: h)
    return Double(u ^ (u >> 16)) / 4294967296.0
}

private func smoothstepUnit(_ t: Double) -> Double { t * t * (3 - 2 * t) }

private func valueNoise(_ seed: UInt32, _ x: Double, _ z: Double) -> Double {
    let ix = Int32(floor(x))
    let iz = Int32(floor(z))
    let fx = smoothstepUnit(x - floor(x))
    let fz = smoothstepUnit(z - floor(z))
    let a = hash2(seed, ix, iz)
    let b = hash2(seed, ix &+ 1, iz)
    let c = hash2(seed, ix, iz &+ 1)
    let d = hash2(seed, ix &+ 1, iz &+ 1)
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz
}

private func flatten(_ x: Double, _ z: Double, _ cx: Double, _ cz: Double, _ r: Double) -> Double {
    let d = (pow(x - cx, 2) + pow(z - cz, 2)).squareRoot()
    if d >= r + 16 { return 1 }
    if d <= r { return 0 }
    return smoothstepUnit((d - r) / 16)
}

struct RockDef {
    let x: Double
    let z: Double
    let r: Double
    let h: Double
}

struct WorldLayout {
    let padX: Double
    let padZ: Double
    let rocks: [RockDef]
    let nests: [(x: Double, z: Double)]
}

func padPosition(seed: UInt32) -> (x: Double, z: Double) {
    let rng = mulberry32(seed ^ 0x5ADD)
    let ang = rng() * .pi * 2
    let dist = 62 + rng() * 18
    return (cos(ang) * dist, sin(ang) * dist)
}

func terrainHeight(seed: UInt32, x: Double, z: Double) -> Double {
    var h = valueNoise(seed, x * 0.02 + 100, z * 0.02 + 100) * 5.0
    h += valueNoise(seed ^ 0x9E37, x * 0.055 + 100, z * 0.055 + 100) * 1.4
    h += valueNoise(seed ^ 0x51AB, x * 0.16 + 100, z * 0.16 + 100) * 0.35
    let pad = padPosition(seed: seed)
    h *= flatten(x, z, 0, 0, 9)
    h *= flatten(x, z, pad.x, pad.z, 10)
    return h
}

func generateLayout(seed: UInt32) -> WorldLayout {
    let pad = padPosition(seed: seed)
    let rng = mulberry32(seed ^ 0x70C5)
    var rocks: [RockDef] = []
    var i = 0
    while i < 140 && rocks.count < 95 {
        i += 1
        let x = (rng() * 2 - 1) * (K.mapHalf - 6)
        let z = (rng() * 2 - 1) * (K.mapHalf - 6)
        let r = 1.1 + rng() * 2.6
        if (x * x + z * z).squareRoot() < 14 + r { continue }
        if (pow(x - pad.x, 2) + pow(z - pad.z, 2)).squareRoot() < 13 + r { continue }
        rocks.append(RockDef(x: x, z: z, r: r, h: r * (1.0 + rng() * 0.9)))
    }
    var nests: [(x: Double, z: Double)] = []
    var j = 0
    while j < 40 && nests.count < 5 {
        j += 1
        let ang = rng() * .pi * 2
        let dist = 52 + rng() * 42
        let x = cos(ang) * dist
        let z = sin(ang) * dist
        if abs(x) > K.mapHalf - 8 || abs(z) > K.mapHalf - 8 { continue }
        if (pow(x - pad.x, 2) + pow(z - pad.z, 2)).squareRoot() < 30 { continue }
        if nests.contains(where: { (pow($0.x - x, 2) + pow($0.z - z, 2)).squareRoot() < 34 }) { continue }
        nests.append((x, z))
    }
    return WorldLayout(padX: pad.x, padZ: pad.z, rocks: rocks, nests: nests)
}

// Push a circle out of rocks and map bounds (client-side prediction of the
// same collision rule the server applies).
func resolveCollisions(x: Double, z: Double, radius: Double, rocks: [RockDef]) -> (Double, Double) {
    let lim = K.mapHalf - radius
    var nx = max(-lim, min(lim, x))
    var nz = max(-lim, min(lim, z))
    for rock in rocks {
        let dx = nx - rock.x
        let dz = nz - rock.z
        let minD = rock.r * 0.82 + radius
        let d2 = dx * dx + dz * dz
        if d2 < minD * minD && d2 > 1e-6 {
            let d = d2.squareRoot()
            nx = rock.x + (dx / d) * minD
            nz = rock.z + (dz / d) * minD
        }
    }
    return (nx, nz)
}
