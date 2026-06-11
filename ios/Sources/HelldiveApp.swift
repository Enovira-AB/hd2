// App entry: connect screen → lobby → SceneKit game view with touch controls.

import SwiftUI
import SceneKit

@main
struct HelldiveApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
                .preferredColorScheme(.dark)
                .statusBarHidden()
        }
    }
}

struct RootView: View {
    @StateObject private var net = NetClient()
    @AppStorage("callsign") private var callsign = ""
    @AppStorage("serverURL") private var serverURL = "http://192.168.1.50:8080"
    @State private var roomCode = ""

    var body: some View {
        ZStack {
            Color(red: 0.024, green: 0.031, blue: 0.047).ignoresSafeArea()
            if !net.connected {
                menu
            } else if net.mission?.phase == "LOBBY" {
                lobby
            } else {
                GameView(net: net)
            }
        }
    }

    private var menu: some View {
        VStack(spacing: 14) {
            Text("HELLDIVE")
                .font(.system(size: 54, weight: .heavy))
                .kerning(10)
                .foregroundColor(Color(red: 1, green: 0.85, blue: 0.29))
            Text("NATIVE DIVE FOR MANAGED DEMOCRACY")
                .font(.caption2).kerning(4).opacity(0.6)
            TextField("CALLSIGN", text: $callsign)
                .textFieldStyle(.roundedBorder)
                .frame(width: 240)
            TextField("SERVER URL", text: $serverURL)
                .textFieldStyle(.roundedBorder)
                .frame(width: 280)
                .font(.caption)
            HStack {
                Button("NEW SQUAD") { connect(nil) }
                    .buttonStyle(.borderedProminent)
                TextField("CODE", text: $roomCode)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 80)
                Button("JOIN") { connect(roomCode) }
                    .buttonStyle(.bordered)
            }
            if let err = net.lastError {
                Text(err.uppercased()).font(.caption).foregroundColor(.red)
            }
        }
    }

    private var lobby: some View {
        VStack(spacing: 10) {
            Text("SQUAD CODE").font(.caption).kerning(4).opacity(0.6)
            Text(net.room)
                .font(.system(size: 64, weight: .heavy))
                .kerning(14)
                .foregroundColor(Color(red: 1, green: 0.85, blue: 0.29))
            ForEach(net.latestPlayers, id: \.id) { p in
                Text(p.name.uppercased()).kerning(3)
            }
            if net.selfId == net.hostId {
                Button("DEPLOY ⬇") { net.send(ClientMsg.start()) }
                    .buttonStyle(.borderedProminent)
                    .padding(.top, 12)
            } else {
                Text("waiting for host…").font(.caption).opacity(0.5).padding(.top, 12)
            }
        }
    }

    private func connect(_ room: String?) {
        net.lastError = nil
        net.connect(
            serverURL: serverURL,
            name: callsign.isEmpty ? "Helldiver" : callsign,
            room: room?.uppercased()
        )
    }
}

// SceneKit viewport + virtual stick / look / fire overlay.
struct GameView: View {
    @ObservedObject var net: NetClient
    @State private var controller: GameController?

    var body: some View {
        ZStack {
            if let controller {
                SceneKitView(controller: controller)
                    .ignoresSafeArea()
                controls(controller)
            } else {
                Color.black.onAppear { controller = GameController(net: net) }
            }
        }
    }

    @ViewBuilder
    private func controls(_ c: GameController) -> some View {
        HStack {
            // left: move stick
            GeometryReader { _ in
                Color.clear
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { v in
                                let dx = v.translation.width / 60
                                let dy = -v.translation.height / 60
                                c.moveInput = SIMD2(
                                    max(-1, min(1, Double(dx))),
                                    max(-1, min(1, Double(dy)))
                                )
                            }
                            .onEnded { _ in c.moveInput = .zero }
                    )
            }
            // right: look + fire
            GeometryReader { _ in
                Color.clear
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { v in
                                c.yaw -= Double(v.velocity.width) * 0.00004
                                c.pitch -= Double(v.velocity.height) * 0.00004
                                c.pitch = max(-0.55, min(1.1, c.pitch))
                            }
                    )
            }
        }
        .overlay(alignment: .bottomTrailing) {
            VStack(spacing: 14) {
                Button {
                    net.send(ClientMsg.reload())
                } label: {
                    Text("R").frame(width: 54, height: 54)
                }
                .background(.black.opacity(0.5), in: Circle())

                Text("FIRE")
                    .frame(width: 84, height: 84)
                    .background(.black.opacity(0.5), in: Circle())
                    .overlay(Circle().stroke(.red.opacity(0.6)))
                    .onLongPressGesture(
                        minimumDuration: 0.01,
                        pressing: { pressing in c.firing = pressing },
                        perform: {}
                    )
            }
            .padding(24)
            .foregroundColor(.white)
        }
        .overlay(alignment: .topTrailing) {
            if let m = net.mission {
                VStack(alignment: .trailing) {
                    Text(m.phase).font(.headline).kerning(3)
                        .foregroundColor(Color(red: 1, green: 0.85, blue: 0.29))
                    Text("KILLS \(m.kills)/\(m.killTarget)").font(.caption).kerning(2)
                }
                .padding()
            }
        }
    }
}

struct SceneKitView: UIViewRepresentable {
    let controller: GameController

    func makeUIView(context: Context) -> SCNView {
        let view = SCNView()
        view.scene = controller.scene
        view.pointOfView = controller.cameraNode
        view.delegate = controller
        view.rendersContinuously = true
        view.antialiasingMode = .multisampling2X
        view.backgroundColor = .black
        return view
    }

    func updateUIView(_ uiView: SCNView, context: Context) {}
}
