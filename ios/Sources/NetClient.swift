// WebSocket client with server-clock estimation and snapshot interpolation —
// the Swift twin of web/src/net.ts.

import Foundation

struct Snapshot {
    let t: Double
    let players: [PlayerState]
    let bugs: [BugState]
    let supplies: [SupplyState]
}

final class NetClient: NSObject, ObservableObject {
    private var task: URLSessionWebSocketTask?
    private var snapshots: [Snapshot] = []
    private var clockOffset: Double = 0
    private var bestRtt: Double = .infinity
    private var pingTimer: Timer?

    @Published var selfId = ""
    @Published var room = ""
    @Published var hostId = ""
    @Published var mission: MissionState?
    @Published var latestPlayers: [PlayerState] = []
    @Published var latestSupplies: [SupplyState] = []
    @Published var connected = false
    @Published var lastError: String?

    var onEvent: ((ServerMsg) -> Void)?

    func connect(serverURL: String, name: String, room: String?) {
        guard var comps = URLComponents(string: serverURL) else {
            lastError = "Bad server URL"
            return
        }
        comps.scheme = comps.scheme == "https" ? "wss" : "ws"
        comps.path = "/ws"
        guard let url = comps.url else {
            lastError = "Bad server URL"
            return
        }
        let session = URLSession(configuration: .default)
        task = session.webSocketTask(with: url)
        task?.resume()
        send(ClientMsg.join(name: name, room: room))
        receiveLoop()
        DispatchQueue.main.async {
            self.pingTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
                self?.send(ClientMsg.ping(t: Date().timeIntervalSince1970 * 1000))
            }
        }
    }

    func disconnect() {
        pingTimer?.invalidate()
        task?.cancel(with: .goingAway, reason: nil)
        connected = false
    }

    func send(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let text = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(text)) { _ in }
    }

    func serverNow() -> Double {
        Date().timeIntervalSince1970 * 1000 + clockOffset
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let err):
                DispatchQueue.main.async {
                    self.connected = false
                    self.lastError = err.localizedDescription
                }
            case .success(let message):
                if case .string(let text) = message, let data = text.data(using: .utf8),
                   let msg = try? JSONDecoder().decode(ServerMsg.self, from: data) {
                    DispatchQueue.main.async { self.ingest(msg) }
                }
                self.receiveLoop()
            }
        }
    }

    private func ingest(_ msg: ServerMsg) {
        switch msg {
        case .welcome(let selfId, let room, let host, let mission, let players):
            self.selfId = selfId
            self.room = room
            self.hostId = host
            self.mission = mission
            self.latestPlayers = players
            self.connected = true
        case .errorMsg(let reason):
            if !connected { lastError = reason }
        case .snapshot(let t, let players, let bugs, let supplies, let mission):
            snapshots.append(Snapshot(t: t, players: players, bugs: bugs, supplies: supplies))
            if snapshots.count > 30 { snapshots.removeFirst() }
            self.mission = mission
            self.latestPlayers = players
            self.latestSupplies = supplies
        case .phase(let mission):
            self.mission = mission
        case .left(_, let host):
            self.hostId = host
        case .pong(let t, let now):
            let rtt = Date().timeIntervalSince1970 * 1000 - t
            if rtt <= bestRtt + 30 {
                bestRtt = min(bestRtt, rtt)
                clockOffset = now + rtt / 2 - Date().timeIntervalSince1970 * 1000
            }
        default:
            break
        }
        onEvent?(msg)
    }

    // Interpolated remote state at (serverNow - interpDelay), like web net.ts.
    func sample() -> (players: [PlayerState], bugs: [BugState]) {
        guard let last = snapshots.last else { return ([], []) }
        guard snapshots.count > 1 else { return (last.players, last.bugs) }

        let renderT = serverNow() - K.interpDelayMs
        var s0 = snapshots[0]
        var s1 = last
        for i in 0..<(snapshots.count - 1) {
            if snapshots[i].t <= renderT && renderT <= snapshots[i + 1].t {
                s0 = snapshots[i]
                s1 = snapshots[i + 1]
                break
            }
        }
        if renderT >= s1.t { return (s1.players, s1.bugs) }
        let span = max(1, s1.t - s0.t)
        let a = max(0, min(1, (renderT - s0.t) / span))

        let players = s1.players.map { p1 -> PlayerState in
            guard let p0 = s0.players.first(where: { $0.id == p1.id }) else { return p1 }
            return PlayerState(
                id: p1.id, name: p1.name,
                pos: lerp3(p0.pos, p1.pos, a),
                yaw: lerpAngle(p0.yaw, p1.yaw, a),
                pitch: p0.pitch + (p1.pitch - p0.pitch) * a,
                anim: p1.anim, hp: p1.hp, ammo: p1.ammo, reserve: p1.reserve,
                kills: p1.kills, boarded: p1.boarded
            )
        }
        let bugs = s1.bugs.map { b1 -> BugState in
            guard let b0 = s0.bugs.first(where: { $0.id == b1.id }) else { return b1 }
            return BugState(
                id: b1.id, kind: b1.kind,
                pos: lerp3(b0.pos, b1.pos, a),
                yaw: lerpAngle(b0.yaw, b1.yaw, a),
                hp: b1.hp
            )
        }
        return (players, bugs)
    }
}

private func lerp3(_ a: [Double], _ b: [Double], _ t: Double) -> [Double] {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

private func lerpAngle(_ a: Double, _ b: Double, _ t: Double) -> Double {
    var d = b - a
    while d > .pi { d -= .pi * 2 }
    while d < -.pi { d += .pi * 2 }
    return a + d * t
}
