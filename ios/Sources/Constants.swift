// Mirror of shared/constants.ts — keep in sync by hand.
// The server is authoritative for all of these; the client only needs the
// ones that affect prediction, rendering and input.

import Foundation

enum K {
    static let protocolVersion = 1

    static let interpDelayMs: Double = 120
    static let clientSendRate: Double = 20

    static let mapHalf: Double = 110
    static let walkSpeed: Double = 5.2
    static let sprintSpeed: Double = 8.4

    static let playerMaxHp = 100
    static let rifleMagSize = 30
    static let rifleFireInterval: Double = 0.1
    static let rifleReloadTime: Double = 2.2

    struct BugKind {
        let name: String
        let radius: Double
    }
    static let bugKinds: [BugKind] = [
        BugKind(name: "scavenger", radius: 0.55),
        BugKind(name: "warrior", radius: 0.85),
    ]

    struct Stratagem {
        let kind: String
        let code: String
        let label: String
    }
    static let stratagems: [Stratagem] = [
        Stratagem(kind: "REINFORCE", code: "UDRLU", label: "Reinforce"),
        Stratagem(kind: "ORBITAL", code: "RRU", label: "Orbital Strike"),
        Stratagem(kind: "RESUPPLY", code: "DDUR", label: "Resupply"),
    ]
}
