// SceneKit renderer + local player controller. First native milestone:
// terrain/rocks/pad from the shared seed, soldier & bug nodes, snapshot
// interpolation, third-person camera, movement + fire.
//
// TODO(next milestones): stratagem arrow pad, tracer/explosion particle
// effects, hellpod + shuttle animations, procedural audio (AVAudioEngine),
// supply boxes, death cam.

import Foundation
import SceneKit

final class GameController: NSObject, SCNSceneRendererDelegate {
    let scene = SCNScene()
    let cameraNode = SCNNode()
    private let net: NetClient
    private var layout: WorldLayout?
    private var builtSeed: UInt32 = .max
    private var worldRoot = SCNNode()

    // local player state
    var pos = SIMD3<Double>(0, 0, 0)
    var yaw: Double = 0
    var pitch: Double = 0
    var moveInput = SIMD2<Double>(0, 0) // x strafe, y forward (-1..1)
    var firing = false
    var sprinting = false
    private var lastFireAt: Double = 0
    private var lastSentAt: Double = 0
    private var lastFrameTime: TimeInterval = 0

    private var soldierNodes: [String: SCNNode] = [:]
    private var bugNodes: [Int: SCNNode] = [:]

    init(net: NetClient) {
        self.net = net
        super.init()
        setupAtmosphere()
        scene.rootNode.addChildNode(worldRoot)

        let camera = SCNCamera()
        camera.zFar = 900
        camera.fieldOfView = 58
        camera.wantsHDR = true
        camera.bloomThreshold = 0.45
        camera.bloomIntensity = 0.9
        camera.bloomBlurRadius = 12
        cameraNode.camera = camera
        scene.rootNode.addChildNode(cameraNode)
    }

    private func setupAtmosphere() {
        scene.background.contents = UIColor(red: 0.02, green: 0.027, blue: 0.047, alpha: 1)
        scene.fogColor = UIColor(red: 0.04, green: 0.055, blue: 0.086, alpha: 1)
        scene.fogStartDistance = 18
        scene.fogEndDistance = 95
        scene.fogDensityExponent = 2

        let ambient = SCNNode()
        ambient.light = SCNLight()
        ambient.light!.type = .ambient
        ambient.light!.color = UIColor(red: 0.10, green: 0.13, blue: 0.21, alpha: 1)
        ambient.light!.intensity = 220
        scene.rootNode.addChildNode(ambient)

        let moon = SCNNode()
        moon.light = SCNLight()
        moon.light!.type = .directional
        moon.light!.color = UIColor(red: 0.62, green: 0.71, blue: 0.91, alpha: 1)
        moon.light!.intensity = 420
        moon.light!.castsShadow = true
        moon.light!.shadowMapSize = CGSize(width: 1024, height: 1024)
        moon.eulerAngles = SCNVector3(-0.9, 0.5, 0)
        scene.rootNode.addChildNode(moon)
    }

    // ---- world from seed -------------------------------------------------------

    func buildWorldIfNeeded() {
        guard let mission = net.mission, mission.seed != builtSeed else { return }
        builtSeed = mission.seed
        layout = generateLayout(seed: mission.seed)
        worldRoot.childNodes.forEach { $0.removeFromParentNode() }

        worldRoot.addChildNode(makeTerrainNode(seed: mission.seed))

        let rockMat = SCNMaterial()
        rockMat.diffuse.contents = UIColor(red: 0.23, green: 0.25, blue: 0.28, alpha: 1)
        rockMat.roughness.contents = 0.95
        for rock in layout!.rocks {
            let n = SCNNode(geometry: SCNSphere(radius: 1))
            n.geometry!.materials = [rockMat]
            let y = terrainHeight(seed: mission.seed, x: rock.x, z: rock.z)
            n.position = SCNVector3(rock.x, y + rock.h * 0.12, rock.z)
            n.scale = SCNVector3(rock.r, rock.h, rock.r * 0.9)
            worldRoot.addChildNode(n)
        }

        // extraction pad
        if let l = layout {
            let padY = terrainHeight(seed: mission.seed, x: l.padX, z: l.padZ)
            let pad = SCNNode(geometry: SCNCylinder(radius: 6, height: 0.5))
            pad.geometry!.firstMaterial!.diffuse.contents = UIColor(red: 0.17, green: 0.19, blue: 0.22, alpha: 1)
            pad.geometry!.firstMaterial!.metalness.contents = 0.6
            pad.position = SCNVector3(l.padX, padY + 0.25, l.padZ)
            worldRoot.addChildNode(pad)

            let ring = SCNNode(geometry: SCNTorus(ringRadius: 5.2, pipeRadius: 0.14))
            ring.geometry!.firstMaterial!.emission.contents = UIColor(red: 1, green: 0.85, blue: 0.29, alpha: 1)
            ring.position = SCNVector3(l.padX, padY + 0.55, l.padZ)
            worldRoot.addChildNode(ring)
        }

        // nest glows
        for nest in layout!.nests {
            let y = terrainHeight(seed: mission.seed, x: nest.x, z: nest.z)
            let mound = SCNNode(geometry: SCNSphere(radius: 2.4))
            mound.geometry!.firstMaterial!.diffuse.contents = UIColor(red: 0.2, green: 0.15, blue: 0.11, alpha: 1)
            mound.geometry!.firstMaterial!.emission.contents = UIColor(red: 1, green: 0.35, blue: 0.12, alpha: 1)
            mound.geometry!.firstMaterial!.emission.intensity = 0.5
            mound.position = SCNVector3(nest.x, y - 0.8, nest.z)
            mound.scale = SCNVector3(1, 0.5, 1)
            worldRoot.addChildNode(mound)
        }

        if let selfState = net.latestPlayers.first(where: { $0.id == net.selfId }) {
            pos = SIMD3(selfState.pos[0], selfState.pos[1], selfState.pos[2])
        }
    }

    private func makeTerrainNode(seed: UInt32) -> SCNNode {
        let segs = 96
        let size = K.mapHalf * 2 + 30
        var vertices: [SCNVector3] = []
        var indices: [Int32] = []
        for j in 0...segs {
            for i in 0...segs {
                let x = (Double(i) / Double(segs) - 0.5) * size
                let z = (Double(j) / Double(segs) - 0.5) * size
                vertices.append(SCNVector3(x, terrainHeight(seed: seed, x: x, z: z), z))
            }
        }
        let row = Int32(segs + 1)
        for j in 0..<Int32(segs) {
            for i in 0..<Int32(segs) {
                let a = j * row + i
                let b = a + 1
                let c = a + row
                let d = c + 1
                indices.append(contentsOf: [a, c, b, b, c, d])
            }
        }
        let src = SCNGeometrySource(vertices: vertices)
        let elem = SCNGeometryElement(indices: indices, primitiveType: .triangles)
        let geo = SCNGeometry(sources: [src], elements: [elem])
        let mat = SCNMaterial()
        mat.diffuse.contents = UIColor(red: 0.18, green: 0.20, blue: 0.22, alpha: 1)
        mat.roughness.contents = 0.96
        geo.materials = [mat]
        return SCNNode(geometry: geo)
    }

    // ---- per-frame -----------------------------------------------------------------

    func renderer(_ renderer: SCNSceneRenderer, updateAtTime time: TimeInterval) {
        let dt = lastFrameTime == 0 ? 0.016 : min(0.05, time - lastFrameTime)
        lastFrameTime = time
        DispatchQueue.main.async { [self] in
            buildWorldIfNeeded()
            guard let mission = net.mission, mission.phase != "LOBBY", let layout else { return }
            stepLocalPlayer(dt: dt)
            syncViews(dt: dt)
            _ = layout
        }
    }

    private func stepLocalPlayer(dt: Double) {
        guard let layout, builtSeed != .max else { return }
        let speed = (sprinting ? K.sprintSpeed : K.walkSpeed) * (firing ? 0.6 : 1.0)
        let f = SIMD2(sin(yaw), cos(yaw))
        let r = SIMD2(-f.y, f.x) // screen-right
        let wishX = (f.x * moveInput.y + r.x * moveInput.x) * speed
        let wishZ = (f.y * moveInput.y + r.y * moveInput.x) * speed
        pos.x += wishX * dt
        pos.z += wishZ * dt
        let (cx, cz) = resolveCollisions(x: pos.x, z: pos.z, radius: 0.45, rocks: layout.rocks)
        pos.x = cx
        pos.z = cz
        pos.y = terrainHeight(seed: builtSeed, x: pos.x, z: pos.z)

        // camera: third person over the shoulder
        let f3 = SIMD3(sin(yaw) * cos(pitch), sin(pitch), cos(yaw) * cos(pitch))
        let pivot = pos + SIMD3(0, 1.62, 0)
        var camPos = pivot - f3 * 4.7 + SIMD3(Double(r.x) * 0.85, 0.25, Double(r.y) * 0.85)
        let minY = terrainHeight(seed: builtSeed, x: camPos.x, z: camPos.z) + 0.35
        if camPos.y < minY { camPos.y = minY }
        cameraNode.position = SCNVector3(camPos.x, camPos.y, camPos.z)
        let lookAt = pivot + f3 * 9
        cameraNode.look(at: SCNVector3(lookAt.x, lookAt.y, lookAt.z))

        // fire
        let now = Date().timeIntervalSince1970
        if firing, now - lastFireAt >= K.rifleFireInterval {
            lastFireAt = now
            let eye = pos + SIMD3(0, 1.55, 0)
            net.send(ClientMsg.fire(
                origin: [eye.x, eye.y, eye.z],
                dir: [f3.x, f3.y, f3.z]
            ))
        }

        // state @20Hz
        if now - lastSentAt >= 1.0 / K.clientSendRate {
            lastSentAt = now
            var anim = 0
            if abs(moveInput.x) + abs(moveInput.y) > 0.1 { anim |= 1 }
            if sprinting { anim |= 2 }
            if firing { anim |= 4 }
            net.send(ClientMsg.state(pos: [pos.x, pos.y, pos.z], yaw: yaw, pitch: pitch, anim: anim))
        }
    }

    private func syncViews(dt: Double) {
        let sampled = net.sample()
        var seen = Set<String>()
        for p in sampled.players {
            seen.insert(p.id)
            let node = soldierNodes[p.id] ?? {
                let n = Self.makeSoldierNode()
                scene.rootNode.addChildNode(n)
                soldierNodes[p.id] = n
                return n
            }()
            if p.id == net.selfId {
                node.position = SCNVector3(pos.x, pos.y, pos.z)
                node.eulerAngles.y = Float(yaw)
            } else {
                node.position = SCNVector3(p.pos[0], p.pos[1], p.pos[2])
                node.eulerAngles.y = Float(p.yaw)
            }
            node.isHidden = p.boarded
            node.opacity = p.isDead ? 0.4 : 1.0
        }
        for (id, node) in soldierNodes where !seen.contains(id) {
            node.removeFromParentNode()
            soldierNodes.removeValue(forKey: id)
        }

        var seenBugs = Set<Int>()
        for b in sampled.bugs {
            seenBugs.insert(b.id)
            let node = bugNodes[b.id] ?? {
                let n = Self.makeBugNode(kind: b.kind)
                scene.rootNode.addChildNode(n)
                bugNodes[b.id] = n
                return n
            }()
            node.position = SCNVector3(b.pos[0], b.pos[1] - 0.42, b.pos[2])
            node.eulerAngles.y = Float(b.yaw)
        }
        for (id, node) in bugNodes where !seenBugs.contains(id) {
            node.removeFromParentNode()
            bugNodes.removeValue(forKey: id)
        }
        _ = dt
    }

    // ---- node factories ---------------------------------------------------------------

    static func makeSoldierNode() -> SCNNode {
        let root = SCNNode()
        let armor = SCNMaterial()
        armor.diffuse.contents = UIColor(red: 0.29, green: 0.31, blue: 0.35, alpha: 1)
        armor.metalness.contents = 0.35
        armor.roughness.contents = 0.55

        let torso = SCNNode(geometry: SCNBox(width: 0.46, height: 0.52, length: 0.3, chamferRadius: 0.03))
        torso.geometry!.materials = [armor]
        torso.position = SCNVector3(0, 1.42, 0)

        let helmet = SCNNode(geometry: SCNSphere(radius: 0.16))
        helmet.geometry!.materials = [armor]
        helmet.position = SCNVector3(0, 1.84, 0)

        let visor = SCNNode(geometry: SCNBox(width: 0.17, height: 0.06, length: 0.03, chamferRadius: 0))
        visor.geometry!.firstMaterial!.emission.contents = UIColor(red: 0.53, green: 0.85, blue: 1, alpha: 1)
        visor.position = SCNVector3(0, 1.85, 0.145)

        let legs = SCNNode(geometry: SCNBox(width: 0.36, height: 0.95, length: 0.2, chamferRadius: 0.02))
        legs.geometry!.materials = [armor]
        legs.position = SCNVector3(0, 0.5, 0)

        let rifle = SCNNode(geometry: SCNBox(width: 0.07, height: 0.13, length: 0.85, chamferRadius: 0.01))
        rifle.geometry!.firstMaterial!.diffuse.contents = UIColor(red: 0.11, green: 0.12, blue: 0.13, alpha: 1)
        rifle.position = SCNVector3(0.22, 1.5, 0.4)

        let flash = SCNNode()
        flash.light = SCNLight()
        flash.light!.type = .spot
        flash.light!.color = UIColor(red: 1, green: 0.94, blue: 0.83, alpha: 1)
        flash.light!.intensity = 900
        flash.light!.spotInnerAngle = 10
        flash.light!.spotOuterAngle = 38
        flash.light!.attenuationEndDistance = 45
        flash.position = SCNVector3(0, 1.52, 0.2)
        flash.eulerAngles = SCNVector3(-0.06, 0, 0)

        root.addChildNode(torso)
        root.addChildNode(helmet)
        root.addChildNode(visor)
        root.addChildNode(legs)
        root.addChildNode(rifle)
        root.addChildNode(flash)
        return root
    }

    static func makeBugNode(kind: Int) -> SCNNode {
        let scale = K.bugKinds[min(kind, K.bugKinds.count - 1)].radius / 0.55
        let root = SCNNode()
        let shell = SCNMaterial()
        shell.diffuse.contents = UIColor(red: 0.18, green: 0.15, blue: 0.12, alpha: 1)
        shell.roughness.contents = 0.65

        let body = SCNNode(geometry: SCNSphere(radius: 0.42))
        body.geometry!.materials = [shell]
        body.scale = SCNVector3(1.1, 0.65, 1.45)
        body.position = SCNVector3(0, 0.42, 0)

        let head = SCNNode(geometry: SCNSphere(radius: 0.24))
        head.geometry!.materials = [shell]
        head.position = SCNVector3(0, 0.42, 0.62)

        let abdomen = SCNNode(geometry: SCNSphere(radius: 0.34))
        abdomen.geometry!.firstMaterial!.diffuse.contents = UIColor(red: 0.23, green: 0.14, blue: 0.09, alpha: 1)
        abdomen.geometry!.firstMaterial!.emission.contents = UIColor(red: 1, green: 0.48, blue: 0.15, alpha: 1)
        abdomen.geometry!.firstMaterial!.emission.intensity = 0.8
        abdomen.scale = SCNVector3(1, 0.85, 1.3)
        abdomen.position = SCNVector3(0, 0.44, -0.58)

        root.addChildNode(body)
        root.addChildNode(head)
        root.addChildNode(abdomen)
        root.scale = SCNVector3(scale, scale, scale)
        return root
    }
}
