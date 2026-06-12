// Mirror of shared/protocol.ts — JSON messages discriminated by `type`.

import Foundation

struct PlayerState: Decodable {
    let id: String
    let name: String
    let pos: [Double]
    let yaw: Double
    let pitch: Double
    let anim: Int
    let hp: Int
    let ammo: Int
    let reserve: Int
    let kills: Int
    let boarded: Bool

    var isDead: Bool { anim & 16 != 0 }
}

struct BugState: Decodable {
    let id: Int
    let kind: Int
    let pos: [Double]
    let yaw: Double
    let hp: Int
}

struct SupplyState: Decodable {
    let id: Int
    let pos: [Double]
    let charges: Int
}

struct MissionState: Decodable {
    let phase: String
    let seed: UInt32
    let kills: Int
    let killTarget: Int
    let reinforceLeft: Int
    let phaseEndsAt: Double
}

enum ServerMsg {
    case welcome(selfId: String, room: String, host: String, mission: MissionState, players: [PlayerState])
    case errorMsg(reason: String)
    case joined(player: PlayerState)
    case left(id: String, host: String)
    case snapshot(t: Double, players: [PlayerState], bugs: [BugState], supplies: [SupplyState], mission: MissionState)
    case fired(id: String, origin: [Double], dir: [Double], hit: [Double]?, hitKind: String)
    case bugDeath(id: Int, pos: [Double], kind: Int)
    case hit(id: String, hp: Int)
    case down(id: String)
    case strat(id: String, kind: String, target: [Double], at: Double)
    case boom(kind: String, pos: [Double])
    case reinforced(ids: [String], pos: [Double])
    case phase(mission: MissionState)
    case boarded(id: String)
    case pong(t: Double, now: Double)
    case unknown(type: String)
}

extension ServerMsg: Decodable {
    private enum CodingKeys: String, CodingKey {
        case type, `self`, room, host, mission, players, reason, player, id
        case t, bugs, supplies, origin, dir, hit, hitKind, pos, kind, hp
        case target, at, ids, now
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "welcome":
            self = .welcome(
                selfId: try c.decode(String.self, forKey: .self),
                room: try c.decode(String.self, forKey: .room),
                host: try c.decode(String.self, forKey: .host),
                mission: try c.decode(MissionState.self, forKey: .mission),
                players: try c.decode([PlayerState].self, forKey: .players)
            )
        case "error":
            self = .errorMsg(reason: try c.decode(String.self, forKey: .reason))
        case "joined":
            self = .joined(player: try c.decode(PlayerState.self, forKey: .player))
        case "left":
            self = .left(
                id: try c.decode(String.self, forKey: .id),
                host: try c.decode(String.self, forKey: .host)
            )
        case "snapshot":
            self = .snapshot(
                t: try c.decode(Double.self, forKey: .t),
                players: try c.decode([PlayerState].self, forKey: .players),
                bugs: try c.decode([BugState].self, forKey: .bugs),
                supplies: try c.decode([SupplyState].self, forKey: .supplies),
                mission: try c.decode(MissionState.self, forKey: .mission)
            )
        case "fired":
            self = .fired(
                id: try c.decode(String.self, forKey: .id),
                origin: try c.decode([Double].self, forKey: .origin),
                dir: try c.decode([Double].self, forKey: .dir),
                hit: try c.decodeIfPresent([Double].self, forKey: .hit),
                hitKind: try c.decode(String.self, forKey: .hitKind)
            )
        case "bugDeath":
            self = .bugDeath(
                id: try c.decode(Int.self, forKey: .id),
                pos: try c.decode([Double].self, forKey: .pos),
                kind: try c.decode(Int.self, forKey: .kind)
            )
        case "hit":
            self = .hit(
                id: try c.decode(String.self, forKey: .id),
                hp: try c.decode(Int.self, forKey: .hp)
            )
        case "down":
            self = .down(id: try c.decode(String.self, forKey: .id))
        case "strat":
            self = .strat(
                id: try c.decode(String.self, forKey: .id),
                kind: try c.decode(String.self, forKey: .kind),
                target: try c.decode([Double].self, forKey: .target),
                at: try c.decode(Double.self, forKey: .at)
            )
        case "boom":
            self = .boom(
                kind: try c.decode(String.self, forKey: .kind),
                pos: try c.decode([Double].self, forKey: .pos)
            )
        case "reinforced":
            self = .reinforced(
                ids: try c.decode([String].self, forKey: .ids),
                pos: try c.decode([Double].self, forKey: .pos)
            )
        case "phase":
            self = .phase(mission: try c.decode(MissionState.self, forKey: .mission))
        case "boarded":
            self = .boarded(id: try c.decode(String.self, forKey: .id))
        case "pong":
            self = .pong(
                t: try c.decode(Double.self, forKey: .t),
                now: try c.decode(Double.self, forKey: .now)
            )
        default:
            self = .unknown(type: type)
        }
    }
}

// Client → server messages are tiny; build them as dictionaries.
enum ClientMsg {
    static func join(name: String, room: String?) -> [String: Any] {
        var m: [String: Any] = ["type": "join", "v": K.protocolVersion, "name": name]
        if let room, !room.isEmpty { m["room"] = room }
        return m
    }
    static func start() -> [String: Any] { ["type": "start"] }
    static func state(pos: [Double], yaw: Double, pitch: Double, anim: Int) -> [String: Any] {
        ["type": "state", "pos": pos, "yaw": yaw, "pitch": pitch, "anim": anim]
    }
    static func fire(origin: [Double], dir: [Double]) -> [String: Any] {
        ["type": "fire", "origin": origin, "dir": dir]
    }
    static func reload() -> [String: Any] { ["type": "reload"] }
    static func stratagem(kind: String, target: [Double]) -> [String: Any] {
        ["type": "stratagem", "kind": kind, "target": target]
    }
    static func interact() -> [String: Any] { ["type": "interact"] }
    static func ping(t: Double) -> [String: Any] { ["type": "ping", "t": t] }
}
