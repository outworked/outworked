import Phaser from "phaser";
import { Agent, AGENT_COLORS } from "../lib/types";
import {
  buildPalette,
  registerAgentTextures,
  FRAME_PX,
  AnimState,
} from "./SpriteGen";

const TILE = 48;

// Rich color palette
const P = {
  // Floor — warm wood planks
  plank1: 0x7a5c3e,
  plank2: 0x6d5236,
  plank3: 0x8a6a48,
  plankLine: 0x5a422e,
  // Walls
  wall: 0x2a2a40,
  wallDark: 0x1e1e32,
  wallAccent: 0x343450,
  baseboard: 0x4a3a2a,
  // Furniture - desks
  desk: 0x5c4535,
  deskTop: 0x6d553f,
  deskHighlight: 0x7d6549,
  deskLeg: 0x4a3728,
  // Monitor
  monitor: 0x1a1a2e,
  monitorBezel: 0x333344,
  monitorScreen: 0x00d4ff,
  monitorScreenAlt: 0x00ff88,
  // Chair
  chair: 0x2c3e50,
  chairSeat: 0x3a5068,
  chairHighlight: 0x4a6078,
  // Plants
  plant: 0x2d6a4f,
  plantLight: 0x3d8a6f,
  plantDark: 0x1d5a3f,
  plantPot: 0x8b5e3c,
  plantPotHighlight: 0xa67048,
  // Window
  window: 0x87ceeb,
  windowLight: 0xb0e0f0,
  windowFrame: 0x5a5a7a,
  // Rug
  rug: 0x6b2737,
  rugLight: 0x7b3747,
  rugBorder: 0x8b4757,
  rugPattern: 0x5b1727,
  // Bookshelf
  bookshelf: 0x6b4c2a,
  bookshelfDark: 0x5b3c1a,
  book1: 0xe74c3c,
  book2: 0x3498db,
  book3: 0x2ecc71,
  book4: 0xf1c40f,
  book5: 0x9b59b6,
  book6: 0xe67e22,
  // Coffee machine
  coffee: 0x5d4037,
  coffeeHighlight: 0x7d6057,
  coffeeMetal: 0x9e9e9e,
  // Whiteboard
  whiteboard: 0xecf0f1,
  whiteboardFrame: 0x8a9aaa,
  // Lighting
  ceilingLight: 0xf0e68c,
  lampGlow: 0xfff8e1,
};

interface DustMote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  alpha: number;
  size: number;
  life: number;
  maxLife: number;
}

export interface FurnitureItem {
  id: string;
  type:
    | "desk"
    | "plant"
    | "whiteboard"
    | "bookshelf"
    | "coffee-machine"
    | "water-cooler"
    | "printer"
    | "filing-cabinet"
    | "couch"
    | "standing-lamp"
    | "wall-clock"
    | "coat-rack"
    | "snack-machine"
    | "cactus"
    | "tv"
    | "ping-pong"
    | "trash-can"
    | "server-rack"
    | "fire-extinguisher"
    | "umbrella-stand"
    | "mini-fridge"
    | "fan";
  x: number; // tile x
  y: number; // tile y
}

export class OfficeScene extends Phaser.Scene {
  private agents: Agent[] = [];
  private agentSprites: Map<string, Phaser.GameObjects.Container> = new Map();
  private thoughtBubbles: Map<string, Phaser.GameObjects.Container> = new Map();
  private thoughtBubbleLastUpdate: Map<string, number> = new Map();
  private onAgentClick?: (agent: Agent) => void;
  private onAgentMove?: (agentId: string, x: number, y: number) => void;
  private onFurnitureMove?: (items: FurnitureItem[]) => void;
  private walkTimers: Map<string, Phaser.Time.TimerEvent> = new Map();
  private agentTargets: Map<string, { x: number; y: number }> = new Map();
  private selectedAgentId: string | null = null;
  private agentAnimKeys: Map<string, Record<AnimState, string>> = new Map();
  private agentIndex = 0;
  private ready = false;
  private cols = 16;
  private rows = 10;
  private officeGraphics?: Phaser.GameObjects.Graphics;
  /** All background scene objects (lights, dead zone, vignettes) — destroyed on resize */
  private bgObjects: Phaser.GameObjects.GameObject[] = [];
  private deskPositions: { x: number; y: number }[] = []; // tile positions of desk chairs
  private agentSnapshot: Map<
    string,
    {
      status: string;
      name: string;
      role: string;
      color: string;
      thought: string;
      collaboratingWith?: string;
    }
  > = new Map();
  private collaborationLines: Map<string, Phaser.GameObjects.Graphics> =
    new Map();
  private resizeTimer?: ReturnType<typeof setTimeout>;

  // ── Drag-and-drop ──
  private isDragging = false;
  private dragTarget: Phaser.GameObjects.Container | null = null;
  private gridOverlay?: Phaser.GameObjects.Graphics;
  private dragShadow?: Phaser.GameObjects.Graphics;

  // ── Furniture containers ──
  private furnitureContainers: Map<string, Phaser.GameObjects.Container> =
    new Map();
  private furnitureItems: FurnitureItem[] = [];
  private savedLayout: FurnitureItem[] | null = null;

  // ── Ambient particles ──
  private dustMotes: DustMote[] = [];
  private dustGraphics?: Phaser.GameObjects.Graphics;
  private windowBeamZones: { x: number; y1: number; y2: number; w: number }[] =
    [];

  constructor() {
    super({ key: "OfficeScene" });
  }

  setOnAgentClick(cb: (agent: Agent) => void) {
    this.onAgentClick = cb;
  }

  setOnAgentMove(cb: (agentId: string, x: number, y: number) => void) {
    this.onAgentMove = cb;
  }

  setOnFurnitureMove(cb: (items: FurnitureItem[]) => void) {
    this.onFurnitureMove = cb;
  }

  /** Load a saved furniture layout. Must be called before create(). */
  setFurnitureLayout(layout: FurnitureItem[]) {
    this.savedLayout = layout;
  }

  preload() {
    // All graphics are procedurally generated — no external assets needed
  }

  create() {
    this.computeGrid();
    this.drawOffice();
    this.createAllFurniture();
    this.initDustParticles();
    this.ready = true;

    // Enable drag input
    this.input.on(
      "drag",
      (
        _pointer: Phaser.Input.Pointer,
        gameObject: Phaser.GameObjects.Container,
        dragX: number,
        dragY: number,
      ) => {
        gameObject.x = dragX;
        gameObject.y = dragY;
        this.updateGridOverlay(dragX, dragY);
        if (this.dragShadow) {
          this.dragShadow.setPosition(dragX + 3, dragY + 3);
        }
      },
    );

    this.input.on(
      "dragstart",
      (
        _pointer: Phaser.Input.Pointer,
        gameObject: Phaser.GameObjects.Container,
      ) => {
        this.isDragging = true;
        this.dragTarget = gameObject;
        gameObject.setDepth(50);
        // Lift effect
        this.tweens.add({
          targets: gameObject,
          scaleX: 1.15,
          scaleY: 1.15,
          duration: 150,
          ease: "Back.easeOut",
        });
        this.showGridOverlay();
        // Create drop shadow
        this.dragShadow = this.add.graphics();
        this.dragShadow.setDepth(49);
        this.dragShadow.fillStyle(0x000000, 0.2);
        this.dragShadow.fillCircle(0, 0, 22);
        this.dragShadow.setPosition(gameObject.x + 3, gameObject.y + 3);

        // If it's an agent, cancel their walk/bob tweens
        const agentId = gameObject.getData("agentId") as string | undefined;
        if (agentId) {
          this.tweens.killTweensOf(gameObject);
          const timer = this.walkTimers.get(agentId);
          if (timer) {
            timer.destroy();
            this.walkTimers.delete(agentId);
          }
        }
      },
    );

    this.input.on(
      "dragend",
      (
        _pointer: Phaser.Input.Pointer,
        gameObject: Phaser.GameObjects.Container,
      ) => {
        this.isDragging = false;
        this.dragTarget = null;
        this.hideGridOverlay();

        if (this.dragShadow) {
          this.dragShadow.destroy();
          this.dragShadow = undefined;
        }

        // Snap to grid
        const snapped = this.snapToGrid(gameObject.x, gameObject.y);

        // Bounce down to final position
        this.tweens.add({
          targets: gameObject,
          x: snapped.px,
          y: snapped.py,
          scaleX: 1,
          scaleY: 1,
          duration: 250,
          ease: "Bounce.easeOut",
        });

        const agentId = gameObject.getData("agentId") as string | undefined;
        const furnitureId = gameObject.getData("furnitureId") as
          | string
          | undefined;

        if (agentId) {
          gameObject.setDepth(10);
          // Update agent position
          const agent = this.agents.find((a) => a.id === agentId);
          if (agent) {
            agent.position.x = snapped.tileX;
            agent.position.y = snapped.tileY;
            // Restart idle behaviors
            if (agent.status === "idle") {
              this.time.delayedCall(300, () => {
                this.startIdleBob(gameObject, snapped.py);
                this.scheduleWalk(agentId);
              });
            }
            if (this.onAgentMove) {
              this.onAgentMove(agentId, snapped.tileX, snapped.tileY);
            }
          }
        } else if (furnitureId) {
          gameObject.setDepth(5);
          // Update furniture position
          const item = this.furnitureItems.find((f) => f.id === furnitureId);
          if (item) {
            item.x = snapped.tileX;
            item.y = snapped.tileY;
            // If a desk was moved, reassign agents to new desk positions
            if (item.type === 'desk') {
              this.rebuildDeskPositions();
              this.assignDesks();
              // Re-walk any working agents to their (possibly new) desk
              for (const agent of this.agents) {
                if (agent.status !== 'idle' && agent.status !== 'collaborating') {
                  this.transitionAgentStatus(agent);
                }
              }
            }
            if (this.onFurnitureMove) {
              this.onFurnitureMove([...this.furnitureItems]);
            }
          }
        }
      },
    );

    this.scale.on("resize", () => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        if (!this.scene.isActive() || !this.sys.game) return;
        this.rebuildAll();
      }, 150);
    });

    // Render any agents that were set before create() fired
    if (this.agents.length > 0) {
      this.fullRebuildAgents();
    }

    this.events.on("shutdown", () => {
      if (this.resizeTimer) {
        clearTimeout(this.resizeTimer);
        this.resizeTimer = undefined;
      }
    });
  }

  update(_time: number, delta: number) {
    this.updateDustParticles(delta);
  }

  /** Tear down all scene visuals and rebuild from scratch (used on resize) */
  private rebuildAll() {
    // ── Destroy everything ──
    // Background graphics (lights, dead zone, etc.)
    for (const obj of this.bgObjects) obj.destroy();
    this.bgObjects = [];
    // Main office floor/walls
    if (this.officeGraphics) {
      this.officeGraphics.destroy();
      this.officeGraphics = undefined;
    }
    // Furniture
    this.furnitureContainers.forEach((c) => c.destroy());
    this.furnitureContainers.clear();
    // Dust particles
    if (this.dustGraphics) {
      this.dustGraphics.destroy();
      this.dustGraphics = undefined;
    }
    // Grid overlay (in case resize happened during drag)
    this.hideGridOverlay();
    if (this.dragShadow) {
      this.dragShadow.destroy();
      this.dragShadow = undefined;
    }
    this.isDragging = false;
    this.dragTarget = null;

    // ── Rebuild ──
    this.computeGrid();
    // Snapshot current furniture positions so they survive the rebuild
    if (this.furnitureItems.length > 0) {
      this.savedLayout = [...this.furnitureItems];
    }
    this.drawOffice();
    this.createAllFurniture();
    this.initDustParticles();
    if (this.agents.length > 0) {
      this.fullRebuildAgents();
    }
  }

  // ── Public API ──

  updateAgents(agents: Agent[]) {
    const prev = this.agents;
    this.agents = agents;
    if (!this.ready) return;

    const prevIds = new Set(prev.map((a) => a.id));
    const nextIds = new Set(agents.map((a) => a.id));

    const toRebuild = new Set<string>();
    const toTransition = new Set<string>();
    const toRemove = new Set<string>();

    for (const id of prevIds) {
      if (!nextIds.has(id)) toRemove.add(id);
    }

    for (const agent of agents) {
      const snap = this.agentSnapshot.get(agent.id);
      if (!snap) {
        toRebuild.add(agent.id);
      } else if (
        snap.name !== agent.name ||
        snap.role !== agent.role ||
        snap.color !== agent.color
      ) {
        toRebuild.add(agent.id);
      } else if (
        snap.status !== agent.status ||
        snap.collaboratingWith !== agent.collaboratingWith
      ) {
        toTransition.add(agent.id);
      }
    }

    for (const id of toRemove) {
      this.destroyAgentSprite(id);
      this.agentSnapshot.delete(id);
    }

    if (toRebuild.size > 0 || toTransition.size > 0 || toRemove.size > 0) {
      this.assignDesks();
    }

    for (const id of toRebuild) {
      this.destroyAgentSprite(id);
      const agent = agents.find((a) => a.id === id);
      if (agent) this.createAgentSprite(agent);
    }

    for (const id of toTransition) {
      const agent = agents.find((a) => a.id === id);
      if (agent) this.transitionAgentStatus(agent);
    }

    for (const agent of agents) {
      if (toRebuild.has(agent.id) || toTransition.has(agent.id)) continue;
      const snap = this.agentSnapshot.get(agent.id);
      if (snap && snap.thought !== (agent.currentThought ?? "")) {
        this.agentSnapshot.set(agent.id, {
          status: agent.status,
          name: agent.name,
          role: agent.role,
          color: agent.color,
          thought: agent.currentThought ?? "",
          collaboratingWith: agent.collaboratingWith,
        });
        const container = this.agentSprites.get(agent.id);
        if (container) {
          // Throttle bubble updates to avoid excessive recreation during streaming
          const lastUpdate = this.thoughtBubbleLastUpdate.get(agent.id) ?? 0;
          const now = Date.now();
          if (now - lastUpdate < 500 && agent.status !== "idle") continue;
          this.thoughtBubbleLastUpdate.set(agent.id, now);

          this.hideThoughtBubble(agent.id);
          // Auto-show thought bubbles for non-idle agents
          if (agent.currentThought && agent.status !== "idle") {
            this.showThoughtBubble(agent, container);
          }
        }
      }
    }

    for (const id of toRebuild) {
      this.scheduleWalk(id);
    }
  }

  setSelectedAgent(id: string | null) {
    this.selectedAgentId = id;
    this.agentSprites.forEach((container, agentId) => {
      const highlight = container.getByName(
        "highlight",
      ) as Phaser.GameObjects.Graphics | null;
      if (highlight) {
        highlight.setVisible(agentId === id);
      }
    });
  }

  // ── Grid ──

  private computeGrid() {
    const w = this.scale.gameSize.width || this.sys.game.canvas.width || 768;
    const h = this.scale.gameSize.height || this.sys.game.canvas.height || 480;
    this.cols = Math.max(16, Math.ceil(w / TILE));
    this.rows = Math.max(10, Math.ceil(h / TILE));
  }

  private snapToGrid(px: number, py: number) {
    const tileX = Math.max(
      0,
      Math.min(this.cols - 1, Math.round(px / TILE - 0.5)),
    );
    const tileY = Math.max(
      0,
      Math.min(this.rows - 1, Math.round(py / TILE - 0.5)),
    );
    return {
      tileX,
      tileY,
      px: tileX * TILE + TILE / 2,
      py: tileY * TILE + TILE / 2,
    };
  }

  private showGridOverlay() {
    if (this.gridOverlay) this.gridOverlay.destroy();
    const g = this.add.graphics();
    g.setDepth(40);
    g.lineStyle(1, 0xffffff, 0.08);
    for (let x = 0; x <= this.cols; x++) {
      g.lineBetween(x * TILE, 0, x * TILE, this.rows * TILE);
    }
    for (let y = 0; y <= this.rows; y++) {
      g.lineBetween(0, y * TILE, this.cols * TILE, y * TILE);
    }
    this.gridOverlay = g;
  }

  private updateGridOverlay(px: number, py: number) {
    if (!this.gridOverlay) return;
    this.gridOverlay.clear();
    this.gridOverlay.lineStyle(1, 0xffffff, 0.08);
    for (let x = 0; x <= this.cols; x++) {
      this.gridOverlay.lineBetween(x * TILE, 0, x * TILE, this.rows * TILE);
    }
    for (let y = 0; y <= this.rows; y++) {
      this.gridOverlay.lineBetween(0, y * TILE, this.cols * TILE, y * TILE);
    }
    // Highlight target cell
    const snapped = this.snapToGrid(px, py);
    this.gridOverlay.fillStyle(0x6366f1, 0.15);
    this.gridOverlay.fillRect(
      snapped.tileX * TILE,
      snapped.tileY * TILE,
      TILE,
      TILE,
    );
    this.gridOverlay.lineStyle(2, 0x6366f1, 0.4);
    this.gridOverlay.strokeRect(
      snapped.tileX * TILE,
      snapped.tileY * TILE,
      TILE,
      TILE,
    );
  }

  private hideGridOverlay() {
    if (this.gridOverlay) {
      this.gridOverlay.destroy();
      this.gridOverlay = undefined;
    }
  }

  // ── Office background (floor, walls, rug, windows — non-interactive) ──

  private drawOffice() {
    const g = this.add.graphics();
    this.officeGraphics = g;
    const { cols, rows } = this;
    const W = this.scale.gameSize.width;
    const H = this.scale.gameSize.height;

    // ======= FLOOR — warm wood planks =======
    const plankColors = [P.plank1, P.plank2, P.plank3, P.plank1, P.plank2];
    for (let row = 0; row < rows; row++) {
      const baseColor = plankColors[row % plankColors.length];
      g.fillStyle(baseColor, 1);
      g.fillRect(0, row * TILE, cols * TILE, TILE);
      g.lineStyle(1, P.plankLine, 0.35);
      g.lineBetween(0, row * TILE, cols * TILE, row * TILE);
      for (let i = 0; i < 3; i++) {
        const gy = row * TILE + 8 + i * 14;
        g.lineStyle(1, P.plankLine, 0.1);
        g.lineBetween(0, gy, cols * TILE, gy);
      }
      const offset = (row % 2) * (TILE * 1.5);
      g.lineStyle(1, P.plankLine, 0.2);
      for (let x = offset; x < cols * TILE; x += TILE * 3) {
        g.lineBetween(x, row * TILE, x, (row + 1) * TILE);
      }
    }

    // ======= RUG — ornate center rug =======
    const rugW = 8,
      rugH = 4;
    const rugX = Math.floor((cols - rugW) / 2);
    const rugY = Math.floor((rows - rugH) / 2);
    g.fillStyle(0x000000, 0.12);
    g.fillRect(rugX * TILE + 3, rugY * TILE + 3, rugW * TILE, rugH * TILE);
    g.fillStyle(P.rug, 1);
    g.fillRect(rugX * TILE, rugY * TILE, rugW * TILE, rugH * TILE);
    g.fillStyle(P.rugLight, 0.3);
    g.fillRect(
      rugX * TILE + 8,
      rugY * TILE + 8,
      rugW * TILE - 16,
      rugH * TILE - 16,
    );
    g.lineStyle(3, P.rugBorder, 1);
    g.strokeRect(
      rugX * TILE + 4,
      rugY * TILE + 4,
      rugW * TILE - 8,
      rugH * TILE - 8,
    );
    g.lineStyle(1, P.rugBorder, 0.5);
    g.strokeRect(
      rugX * TILE + 10,
      rugY * TILE + 10,
      rugW * TILE - 20,
      rugH * TILE - 20,
    );
    g.lineStyle(1, P.rugPattern, 0.3);
    const rcx = (rugX + rugW / 2) * TILE;
    const rcy = (rugY + rugH / 2) * TILE;
    for (let i = 1; i <= 3; i++) {
      const s = i * 20;
      g.beginPath();
      g.moveTo(rcx, rcy - s);
      g.lineTo(rcx + s * 1.5, rcy);
      g.lineTo(rcx, rcy + s);
      g.lineTo(rcx - s * 1.5, rcy);
      g.closePath();
      g.strokePath();
    }

    // ======= WALLS =======
    const wallH = TILE * 1.5;
    g.fillStyle(P.wall, 1);
    g.fillRect(0, 0, W, wallH);
    g.fillStyle(P.wallDark, 1);
    g.fillRect(0, 0, W, 6);
    g.fillStyle(P.wallAccent, 0.3);
    for (let x = 0; x < W; x += TILE * 4) {
      g.fillRect(x + 4, 8, TILE * 4 - 8, wallH - 16);
    }
    g.fillStyle(P.baseboard, 1);
    g.fillRect(0, wallH - 5, W, 5);
    g.lineStyle(1, 0x3a2a1a, 0.5);
    g.lineBetween(0, wallH - 5, W, wallH - 5);
    g.fillStyle(0x000000, 0.08);
    g.fillRect(0, wallH, W, 16);

    // ======= WINDOWS =======
    const winCount = Math.max(4, Math.floor(cols / 4));
    const winSpacing = cols / winCount;
    this.windowBeamZones = [];
    for (let i = 0; i < winCount; i++) {
      const wx = Math.floor((i + 0.5) * winSpacing) * TILE + 4;
      if (wx + TILE < W) {
        this.drawWindow(g, wx, 10, TILE - 8, wallH - 24);
        this.windowBeamZones.push({
          x: wx + (TILE - 8) / 2,
          y1: wallH,
          y2: H,
          w: TILE + 20,
        });
      }
    }

    // ======= WINDOW LIGHT BEAMS =======
    for (let i = 0; i < winCount; i++) {
      const wx = Math.floor((i + 0.5) * winSpacing) * TILE + 4;
      if (wx + TILE < W) {
        const beamX = wx - 10;
        const beamW = TILE + 10;
        g.fillStyle(0xfff8e1, 0.06);
        g.beginPath();
        g.moveTo(beamX, wallH);
        g.lineTo(beamX - 20, H);
        g.lineTo(beamX + beamW + 20, H);
        g.lineTo(beamX + beamW, wallH);
        g.closePath();
        g.fillPath();
      }
    }

    // ======= CEILING LIGHTS =======
    const lightG = this.add.graphics();
    lightG.setDepth(1);
    const lightSpacing = Math.max(4, Math.floor(cols / 3));
    for (let i = 0; i < 3; i++) {
      const lx = (i + 0.5) * lightSpacing * TILE;
      lightG.fillStyle(P.ceilingLight, 0.6);
      lightG.fillRect(lx - 15, wallH, 30, 4);
      lightG.fillStyle(0xffffff, 0.4);
      lightG.fillRect(lx - 12, wallH + 1, 24, 2);
    }
    this.bgObjects.push(lightG);
  }

  private drawWindow(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    w: number,
    h: number,
  ) {
    g.fillStyle(0x000000, 0.2);
    g.fillRect(x + 2, y + 2, w, h);
    g.fillStyle(P.windowFrame, 1);
    g.fillRect(x - 2, y - 2, w + 4, h + 4);
    g.fillStyle(P.window, 1);
    g.fillRect(x, y, w, h);
    g.fillStyle(P.windowLight, 0.4);
    g.fillRect(x, y, w, h / 3);
    g.fillStyle(P.windowFrame, 1);
    g.fillRect(x + w / 2 - 1, y, 2, h);
    g.fillRect(x, y + h / 2 - 1, w, 2);
    g.fillStyle(0xffffff, 0.15);
    g.fillRect(x + 2, y + 2, w / 2 - 4, h / 2 - 4);
    g.fillStyle(P.windowFrame, 1);
    g.fillRect(x - 3, y + h + 2, w + 6, 3);
    g.fillStyle(0xffffff, 0.1);
    g.fillRect(x - 3, y + h + 2, w + 6, 1);
  }

  // ── Furniture as individual draggable containers ──

  private createAllFurniture() {
    this.deskPositions = [];
    this.furnitureItems = [];

    const deskStart = 2;
    const deskEnd = this.rows - 2;
    const deskRange = deskEnd - deskStart;
    const deskRows: number[] =
      deskRange < 3
        ? [deskStart]
        : deskRange < 6
          ? [deskStart, deskStart + Math.floor(deskRange / 2)]
          : [
              deskStart,
              deskStart + Math.floor(deskRange / 3),
              deskStart + Math.floor((2 * deskRange) / 3),
            ];

    let fIdx = 0;
    const bottomRow = this.rows - 1;
    const rightCol = this.cols - 3;

    // Left wall desks
    for (const dr of deskRows) {
      this.createFurnitureContainer(`desk-${fIdx++}`, "desk", 1, dr);
    }

    // Right wall desks
    for (const dr of deskRows) {
      this.createFurnitureContainer(`desk-${fIdx++}`, "desk", rightCol, dr);
    }

    // Center desks
    const cLeft = Math.floor(this.cols / 2) - 2;
    const cRight = Math.floor(this.cols / 2) + 1;
    this.createFurnitureContainer(`desk-${fIdx++}`, "desk", cLeft, 1);
    this.createFurnitureContainer(`desk-${fIdx++}`, "desk", cRight, 1);

    // Plants (corners)
    this.createFurnitureContainer("plant-0", "plant", 0, 1);
    this.createFurnitureContainer("plant-1", "plant", this.cols - 1, 1);
    this.createFurnitureContainer("plant-2", "plant", 0, bottomRow - 1);
    this.createFurnitureContainer(
      "plant-3",
      "plant",
      this.cols - 1,
      bottomRow - 1,
    );

    // Whiteboard
    this.createFurnitureContainer(
      "whiteboard-0",
      "whiteboard",
      Math.floor((this.cols - 2) / 2),
      0,
    );

    // Bookshelves
    this.createFurnitureContainer(
      "bookshelf-0",
      "bookshelf",
      Math.floor(this.cols * 0.2),
      bottomRow,
    );
    this.createFurnitureContainer(
      "bookshelf-1",
      "bookshelf",
      Math.floor(this.cols * 0.6),
      bottomRow,
    );

    // Coffee machine
    this.createFurnitureContainer(
      "coffee-0",
      "coffee-machine",
      this.cols - 2,
      bottomRow,
    );

    // Water cooler
    this.createFurnitureContainer(
      "water-0",
      "water-cooler",
      Math.floor(this.cols * 0.4),
      bottomRow,
    );

    // ── New furniture ──

    // Printer
    this.createFurnitureContainer(
      "printer-0",
      "printer",
      Math.floor(this.cols / 2),
      3,
    );

    // Filing cabinets
    this.createFurnitureContainer("filing-0", "filing-cabinet", 3, deskRows[0]);
    if (deskRows.length > 1) {
      this.createFurnitureContainer(
        "filing-1",
        "filing-cabinet",
        this.cols - 4,
        deskRows[deskRows.length - 1],
      );
    }

    // Couch
    const couchX = Math.floor(this.cols / 2) - 1;
    const couchY = Math.floor(this.rows / 2) + 1;
    this.createFurnitureContainer("couch-0", "couch", couchX, couchY);

    // Standing lamps
    this.createFurnitureContainer("lamp-0", "standing-lamp", 0, bottomRow);
    this.createFurnitureContainer(
      "lamp-1",
      "standing-lamp",
      this.cols - 1,
      bottomRow,
    );

    // Wall clocks
    this.createFurnitureContainer(
      "clock-0",
      "wall-clock",
      Math.floor(this.cols * 0.15),
      0,
    );
    this.createFurnitureContainer(
      "clock-1",
      "wall-clock",
      Math.floor(this.cols * 0.85),
      0,
    );

    // Coat rack
    this.createFurnitureContainer(
      "coatrack-0",
      "coat-rack",
      Math.floor(this.cols / 2) + 3,
      bottomRow,
    );

    // Snack machine
    this.createFurnitureContainer(
      "snack-0",
      "snack-machine",
      Math.floor(this.cols * 0.8),
      bottomRow,
    );

    // Cactus
    this.createFurnitureContainer(
      "cactus-0",
      "cactus",
      Math.floor(this.cols / 2) - 4,
      1,
    );
    this.createFurnitureContainer(
      "cactus-1",
      "cactus",
      Math.floor(this.cols / 2) + 4,
      1,
    );

    // TV mounted on wall
    this.createFurnitureContainer(
      "tv-0",
      "tv",
      Math.floor(this.cols * 0.35),
      0,
    );

    // Ping pong table (center-ish area)
    this.createFurnitureContainer(
      "pingpong-0",
      "ping-pong",
      Math.floor(this.cols / 2) - 1,
      Math.floor(this.rows / 2) - 1,
    );

    // Trash cans near desks
    this.createFurnitureContainer(
      "trash-0",
      "trash-can",
      3,
      deskRows[deskRows.length - 1] + 1,
    );
    this.createFurnitureContainer(
      "trash-1",
      "trash-can",
      this.cols - 4,
      deskRows[0] + 1,
    );

    // Server rack (back corner)
    this.createFurnitureContainer("server-0", "server-rack", this.cols - 2, 1);

    // Fire extinguisher (wall-mounted)
    this.createFurnitureContainer(
      "fire-0",
      "fire-extinguisher",
      0,
      Math.floor(this.rows / 2),
    );

    // Umbrella stand near entrance
    this.createFurnitureContainer(
      "umbrella-0",
      "umbrella-stand",
      Math.floor(this.cols / 2) - 2,
      bottomRow,
    );

    // Mini fridge
    this.createFurnitureContainer(
      "fridge-0",
      "mini-fridge",
      Math.floor(this.cols * 0.45),
      bottomRow,
    );

    // Desk fan
    this.createFurnitureContainer("fan-0", "fan", 4, deskRows[0]);

    // Build desk chair positions from actual furniture locations
    // (which may have been overridden by saved layout)
    this.rebuildDeskPositions();
  }

  private createFurnitureContainer(
    id: string,
    type: FurnitureItem["type"],
    tileX: number,
    tileY: number,
  ) {
    // Use saved position if available
    const saved = this.savedLayout?.find((f) => f.id === id);
    if (saved) {
      tileX = saved.x;
      tileY = saved.y;
    }

    const container = this.add.container(tileX * TILE, tileY * TILE);
    container.setDepth(5);
    container.setData("furnitureId", id);
    container.setData("furnitureType", type);

    const g = this.add.graphics();

    switch (type) {
      case "desk":
        this.drawDeskGraphics(g);
        break;
      case "plant":
        this.drawPlantGraphics(g);
        break;
      case "whiteboard":
        this.drawWhiteboardGraphics(g);
        break;
      case "bookshelf":
        this.drawBookshelfGraphics(g);
        break;
      case "coffee-machine":
        this.drawCoffeeMachineGraphics(g);
        break;
      case "water-cooler":
        this.drawWaterCoolerGraphics(g);
        break;
      case "printer":
        this.drawPrinterGraphics(g);
        break;
      case "filing-cabinet":
        this.drawFilingCabinetGraphics(g);
        break;
      case "couch":
        this.drawCouchGraphics(g);
        break;
      case "standing-lamp":
        this.drawStandingLampGraphics(g);
        break;
      case "wall-clock":
        this.drawWallClockGraphics(g);
        break;
      case "coat-rack":
        this.drawCoatRackGraphics(g);
        break;
      case "snack-machine":
        this.drawSnackMachineGraphics(g);
        break;
      case "cactus":
        this.drawCactusGraphics(g);
        break;
      case "tv":
        this.drawTvGraphics(g);
        break;
      case "ping-pong":
        this.drawPingPongGraphics(g);
        break;
      case "trash-can":
        this.drawTrashCanGraphics(g);
        break;
      case "server-rack":
        this.drawServerRackGraphics(g);
        break;
      case "fire-extinguisher":
        this.drawFireExtinguisherGraphics(g);
        break;
      case "umbrella-stand":
        this.drawUmbrellaStandGraphics(g);
        break;
      case "mini-fridge":
        this.drawMiniFridgeGraphics(g);
        break;
      case "fan":
        this.drawFanGraphics(g);
        break;
    }

    container.add(g);

    // Make interactive and draggable
    const wideTypes = new Set([
      "desk",
      "bookshelf",
      "whiteboard",
      "couch",
      "snack-machine",
      "ping-pong",
      "tv",
    ]);
    const tallTypes = new Set([
      "desk",
      "snack-machine",
      "filing-cabinet",
      "server-rack",
    ]);
    const hitW = wideTypes.has(type) ? TILE * 2 : TILE;
    const hitH = tallTypes.has(type) ? TILE * 2 : TILE;
    container.setSize(hitW, hitH);
    container.setInteractive({ cursor: "grab", draggable: true });
    this.input.setDraggable(container);

    // Hover feedback
    container.on("pointerover", () => {
      if (!this.isDragging) {
        this.tweens.add({
          targets: container,
          scaleX: 1.04,
          scaleY: 1.04,
          duration: 120,
          ease: "Quad.easeOut",
        });
      }
    });
    container.on("pointerout", () => {
      if (!this.isDragging || this.dragTarget !== container) {
        this.tweens.add({
          targets: container,
          scaleX: 1,
          scaleY: 1,
          duration: 120,
          ease: "Quad.easeOut",
        });
      }
    });

    this.furnitureContainers.set(id, container);
    this.furnitureItems.push({ id, type, x: tileX, y: tileY });
  }

  private rebuildDeskPositions() {
    this.deskPositions = [];
    for (const item of this.furnitureItems) {
      if (item.type === "desk") {
        this.deskPositions.push({ x: item.x + 1, y: item.y + 1 });
      }
    }
  }

  // ── Furniture drawing helpers (draw at local 0,0 within container) ──

  private drawDeskGraphics(g: Phaser.GameObjects.Graphics) {
    const dw = TILE * 2;
    const cx = TILE; // center

    g.fillStyle(0x000000, 0.12);
    g.fillRect(3, 10, dw, TILE - 6);
    g.fillStyle(P.deskLeg, 1);
    g.fillRect(4, 10, 4, TILE - 8);
    g.fillRect(dw - 8, 10, 4, TILE - 8);
    g.fillStyle(P.desk, 1);
    g.fillRect(0, 6, dw, TILE - 10);
    g.fillStyle(P.deskTop, 1);
    g.fillRect(0, 0, dw, 8);
    g.fillStyle(P.deskHighlight, 0.5);
    g.fillRect(2, 1, dw - 4, 3);

    // Monitor
    g.fillStyle(P.monitorBezel, 1);
    g.fillRect(cx - 15, -24, 30, 22);
    g.fillStyle(P.monitor, 1);
    g.fillRect(cx - 13, -22, 26, 16);
    const screenColors = [0x00d4ff, 0x00ff88, 0xff6b9d, 0xffd93d];
    for (let i = 0; i < 5; i++) {
      const lineW = 6 + ((i * 7 + 3) % 14);
      g.fillStyle(screenColors[i % screenColors.length], 0.7);
      g.fillRect(cx - 11, -20 + i * 3, lineW, 1.5);
    }
    g.fillStyle(P.monitorScreen, 0.08);
    g.fillCircle(cx, -14, 20);
    g.fillStyle(P.monitorBezel, 1);
    g.fillRect(cx - 3, -2, 6, 3);
    g.fillRect(cx - 6, 0, 12, 2);

    // Keyboard
    g.fillStyle(0x555555, 1);
    g.fillRect(cx - 10, 2, 20, 5);
    g.fillStyle(0x666666, 1);
    g.fillRect(cx - 9, 3, 18, 3);
    g.fillStyle(0x777777, 0.6);
    for (let i = 0; i < 5; i++) {
      g.fillRect(cx - 8 + i * 4, 3.5, 2, 1);
    }

    // Mouse
    g.fillStyle(0x555555, 1);
    g.fillRect(cx + 14, 3, 5, 4);
    g.fillStyle(0x666666, 1);
    g.fillRect(cx + 14, 3, 5, 2);

    // Coffee mug
    g.fillStyle(0xffffff, 0.9);
    g.fillRect(6, 1, 6, 5);
    g.fillStyle(0x8b4513, 0.4);
    g.fillRect(7, 2, 4, 2);

    // Chair
    g.fillStyle(0x000000, 0.1);
    g.fillRect(cx - 9, TILE + 4, 20, 16);
    g.fillStyle(P.chair, 1);
    g.fillRect(cx - 10, TILE, 20, 18);
    g.fillStyle(P.chairHighlight, 0.4);
    g.fillRect(cx - 8, TILE + 2, 16, 6);
    g.fillStyle(P.chairSeat, 1);
    g.fillRect(cx - 10, TILE - 3, 20, 6);
    g.fillStyle(P.chairHighlight, 0.3);
    g.fillRect(cx - 8, TILE - 2, 16, 3);
    g.fillStyle(0x333333, 0.6);
    g.fillCircle(cx - 8, TILE + 18, 2);
    g.fillCircle(cx + 8, TILE + 18, 2);
    g.fillCircle(cx, TILE + 19, 2);
  }

  private drawPlantGraphics(g: Phaser.GameObjects.Graphics) {
    g.fillStyle(0x000000, 0.1);
    g.fillCircle(24, 42, 12);
    g.fillStyle(P.plantPot, 1);
    g.fillRect(10, 26, 28, 18);
    g.fillStyle(P.plantPotHighlight, 1);
    g.fillRect(8, 24, 32, 4);
    g.fillStyle(P.plantPotHighlight, 0.3);
    g.fillRect(12, 28, 6, 14);
    g.fillStyle(0x000000, 0.1);
    g.fillRect(28, 28, 8, 14);
    g.fillStyle(0x3d2b1f, 1);
    g.fillRect(12, 24, 24, 3);
    g.fillStyle(P.plantDark, 1);
    g.fillCircle(24, 18, 13);
    g.fillCircle(15, 22, 9);
    g.fillCircle(33, 22, 9);
    g.fillStyle(P.plant, 1);
    g.fillCircle(24, 14, 12);
    g.fillCircle(16, 20, 8);
    g.fillCircle(32, 20, 8);
    g.fillStyle(P.plantLight, 1);
    g.fillCircle(22, 10, 6);
    g.fillCircle(14, 17, 4);
    g.fillCircle(30, 16, 5);
    g.fillStyle(0x4daa7f, 0.4);
    g.fillCircle(20, 8, 3);
  }

  private drawWhiteboardGraphics(g: Phaser.GameObjects.Graphics) {
    const bw = TILE * 2;
    const bh = TILE - 4;
    g.fillStyle(0x000000, 0.15);
    g.fillRect(2, 2, bw, bh);
    g.fillStyle(P.whiteboardFrame, 1);
    g.fillRect(0, 0, bw, bh);
    g.fillStyle(P.whiteboard, 1);
    g.fillRect(4, 4, bw - 8, bh - 8);
    g.fillStyle(0xffffff, 0.15);
    g.fillRect(4, 4, bw / 2 - 6, bh / 2 - 6);
    const noteColors = [0xfff176, 0x80cbc4, 0xef9a9a, 0x90caf9];
    for (let i = 0; i < 4; i++) {
      const nx = 8 + (i % 2) * 42;
      const ny = 8 + Math.floor(i / 2) * 14;
      g.fillStyle(noteColors[i], 0.85);
      g.fillRect(nx, ny, 36, 10);
      g.fillStyle(0x333333, 0.4);
      g.fillRect(nx + 3, ny + 3, 20 + i * 3, 1.5);
      g.fillRect(nx + 3, ny + 6, 12 + i * 5, 1.5);
    }
    g.fillStyle(0x999999, 1);
    g.fillRect(20, bh - 2, bw - 40, 3);
    const markerColors = [0xe74c3c, 0x2ecc71, 0x3498db, 0x1a1a2e];
    for (let i = 0; i < 4; i++) {
      g.fillStyle(markerColors[i], 1);
      g.fillRect(24 + i * 12, bh - 3, 8, 2);
    }
  }

  private drawBookshelfGraphics(g: Phaser.GameObjects.Graphics) {
    const sw = TILE * 2;
    const sh = TILE;
    g.fillStyle(0x000000, 0.1);
    g.fillRect(3, 3, sw, sh);
    g.fillStyle(P.bookshelf, 1);
    g.fillRect(0, 0, sw, sh);
    g.fillStyle(P.bookshelfDark, 1);
    g.fillRect(0, 0, 3, sh);
    g.fillRect(sw - 3, 0, 3, sh);
    g.fillStyle(P.bookshelfDark, 1);
    g.fillRect(3, sh / 2 - 1, sw - 6, 3);
    g.fillStyle(0xffffff, 0.08);
    g.fillRect(0, 0, sw, 2);
    const books1 = [P.book1, P.book2, P.book3, P.book4, P.book5, P.book6];
    for (let i = 0; i < 6; i++) {
      const bh = sh / 2 - 6 + (i % 3) * 2;
      const bx = 5 + i * 14;
      g.fillStyle(books1[i], 1);
      g.fillRect(bx, sh / 2 - bh - 1, 10, bh);
      g.fillStyle(0xffffff, 0.12);
      g.fillRect(bx, sh / 2 - bh - 1, 3, bh);
    }
    const books2 = [P.book4, P.book1, P.book5, P.book2, P.book6, P.book3];
    for (let i = 0; i < 6; i++) {
      const bh = sh / 2 - 6 + ((i + 1) % 3) * 2;
      const bx = 5 + i * 14;
      g.fillStyle(books2[i], 1);
      g.fillRect(bx, sh - bh - 2, 10, bh);
      g.fillStyle(0xffffff, 0.12);
      g.fillRect(bx, sh - bh - 2, 3, bh);
    }
  }

  private drawCoffeeMachineGraphics(g: Phaser.GameObjects.Graphics) {
    const x = 4,
      y = 4;
    g.fillStyle(0x000000, 0.1);
    g.fillRect(x + 2, y + 2, 34, 38);
    g.fillStyle(P.coffee, 1);
    g.fillRect(x, y, 32, 36);
    g.fillStyle(P.coffeeHighlight, 0.4);
    g.fillRect(x + 2, y + 2, 10, 32);
    g.fillStyle(0x263238, 1);
    g.fillRect(x + 4, y + 4, 24, 14);
    g.fillStyle(0x00e676, 0.6);
    g.fillRect(x + 6, y + 6, 20, 10);
    g.fillStyle(0x00e676, 0.4);
    g.fillRect(x + 8, y + 8, 8, 1.5);
    g.fillRect(x + 8, y + 11, 12, 1.5);
    g.fillStyle(P.coffeeMetal, 1);
    g.fillCircle(x + 10, y + 22, 3);
    g.fillCircle(x + 22, y + 22, 3);
    g.fillStyle(0xffffff, 0.2);
    g.fillCircle(x + 9, y + 21, 1.5);
    g.fillCircle(x + 21, y + 21, 1.5);
    g.fillStyle(P.coffeeMetal, 1);
    g.fillRect(x + 4, y + 28, 24, 6);
    g.fillStyle(0x000000, 0.1);
    g.fillRect(x + 6, y + 29, 20, 4);
    // Steam
    g.fillStyle(0xffffff, 0.08);
    g.fillCircle(x + 16, y - 4, 4);
    g.fillCircle(x + 14, y - 10, 3);
    g.fillCircle(x + 18, y - 14, 2);
  }

  private drawWaterCoolerGraphics(g: Phaser.GameObjects.Graphics) {
    g.fillStyle(0x000000, 0.1);
    g.fillRect(3, 3, 24, 44);
    g.fillStyle(0xeceff1, 1);
    g.fillRect(0, 16, 24, 30);
    g.fillStyle(0xffffff, 0.2);
    g.fillRect(2, 18, 6, 26);
    g.fillStyle(0xb3e5fc, 0.5);
    g.fillRect(4, 0, 16, 18);
    g.fillStyle(0x0288d1, 1);
    g.fillRect(6, -2, 12, 3);
    g.fillStyle(0x4fc3f7, 0.4);
    g.fillRect(5, 4, 14, 12);
    g.fillStyle(0xffffff, 0.2);
    g.fillRect(6, 2, 3, 14);
    g.fillStyle(P.coffeeMetal, 1);
    g.fillRect(8, 24, 8, 3);
    g.fillStyle(0xffffff, 0.8);
    g.fillRect(9, 30, 6, 6);
  }

  // ── New furniture drawing methods ──

  private drawPrinterGraphics(g: Phaser.GameObjects.Graphics) {
    // Shadow
    g.fillStyle(0x000000, 0.1);
    g.fillRect(3, 3, 38, 30);
    // Body
    g.fillStyle(0xdde0e3, 1);
    g.fillRect(0, 0, 36, 28);
    // Top panel darker
    g.fillStyle(0xc0c4c8, 1);
    g.fillRect(0, 0, 36, 8);
    // Paper output slot
    g.fillStyle(0x333333, 1);
    g.fillRect(4, 8, 28, 3);
    // Paper sticking out
    g.fillStyle(0xffffff, 0.9);
    g.fillRect(8, 5, 20, 6);
    // Paper lines
    g.fillStyle(0xcccccc, 0.5);
    g.fillRect(10, 7, 12, 1);
    g.fillRect(10, 9, 8, 1);
    // Control panel
    g.fillStyle(0x263238, 1);
    g.fillRect(6, 14, 14, 8);
    // LCD display
    g.fillStyle(0x00e676, 0.5);
    g.fillRect(7, 15, 12, 4);
    // Buttons
    g.fillStyle(0x4caf50, 1);
    g.fillCircle(26, 18, 3);
    g.fillStyle(0xf44336, 1);
    g.fillCircle(26, 24, 2);
    // Paper tray
    g.fillStyle(0xb0bec5, 1);
    g.fillRect(2, 26, 32, 4);
    // Highlight
    g.fillStyle(0xffffff, 0.15);
    g.fillRect(2, 1, 8, 26);
  }

  private drawFilingCabinetGraphics(g: Phaser.GameObjects.Graphics) {
    // Shadow
    g.fillStyle(0x000000, 0.1);
    g.fillRect(3, 3, 26, 44);
    // Body
    g.fillStyle(0x78909c, 1);
    g.fillRect(0, 0, 24, 42);
    // Highlight edge
    g.fillStyle(0x90a4ae, 0.5);
    g.fillRect(1, 1, 4, 40);
    // Top drawer
    g.fillStyle(0x607d8b, 1);
    g.fillRect(2, 2, 20, 12);
    g.fillStyle(P.coffeeMetal, 1);
    g.fillRect(9, 7, 6, 2);
    // Middle drawer
    g.fillStyle(0x607d8b, 1);
    g.fillRect(2, 16, 20, 12);
    g.fillStyle(P.coffeeMetal, 1);
    g.fillRect(9, 21, 6, 2);
    // Bottom drawer
    g.fillStyle(0x607d8b, 1);
    g.fillRect(2, 30, 20, 10);
    g.fillStyle(P.coffeeMetal, 1);
    g.fillRect(9, 34, 6, 2);
    // Label on top drawer
    g.fillStyle(0xffffff, 0.6);
    g.fillRect(6, 3, 12, 3);
  }

  private drawCouchGraphics(g: Phaser.GameObjects.Graphics) {
    // Shadow
    g.fillStyle(0x000000, 0.1);
    g.fillRect(3, 3, TILE * 2 - 2, 32);
    // Couch base
    g.fillStyle(0x5d4037, 1);
    g.fillRect(0, 8, TILE * 2 - 4, 24);
    // Cushions
    g.fillStyle(0x795548, 1);
    g.fillRect(2, 4, TILE - 6, 20);
    g.fillRect(TILE - 2, 4, TILE - 6, 20);
    // Cushion highlights
    g.fillStyle(0x8d6e63, 0.5);
    g.fillRect(4, 6, TILE - 10, 8);
    g.fillRect(TILE, 6, TILE - 10, 8);
    // Arm rests
    g.fillStyle(0x4e342e, 1);
    g.fillRect(-2, 2, 6, 26);
    g.fillRect(TILE * 2 - 8, 2, 6, 26);
    // Arm rest tops
    g.fillStyle(0x6d4c41, 0.6);
    g.fillRect(-1, 2, 4, 4);
    g.fillRect(TILE * 2 - 7, 2, 4, 4);
    // Back rest
    g.fillStyle(0x4e342e, 1);
    g.fillRect(0, -2, TILE * 2 - 4, 8);
    // Back cushion detail
    g.fillStyle(0x5d4037, 0.6);
    g.fillRect(4, 0, TILE * 2 - 12, 4);
    // Pillow
    g.fillStyle(0xbcaaa4, 0.8);
    g.fillRect(6, 6, 12, 10);
    g.fillStyle(0xd7ccc8, 0.4);
    g.fillRect(7, 7, 5, 4);
    // Legs
    g.fillStyle(0x3e2723, 1);
    g.fillRect(2, 28, 4, 4);
    g.fillRect(TILE * 2 - 10, 28, 4, 4);
  }

  private drawStandingLampGraphics(g: Phaser.GameObjects.Graphics) {
    // Base
    g.fillStyle(0x333333, 1);
    g.fillCircle(16, 42, 8);
    g.fillStyle(0x444444, 0.5);
    g.fillCircle(14, 40, 3);
    // Pole
    g.fillStyle(0x555555, 1);
    g.fillRect(14, 4, 4, 38);
    g.fillStyle(0x666666, 0.4);
    g.fillRect(15, 4, 1.5, 38);
    // Shade
    g.fillStyle(0xfff8e1, 1);
    g.beginPath();
    g.moveTo(6, 4);
    g.lineTo(26, 4);
    g.lineTo(22, -8);
    g.lineTo(10, -8);
    g.closePath();
    g.fillPath();
    // Shade detail
    g.fillStyle(0xfff176, 0.3);
    g.beginPath();
    g.moveTo(8, 3);
    g.lineTo(14, 3);
    g.lineTo(12, -6);
    g.lineTo(11, -6);
    g.closePath();
    g.fillPath();
    // Glow
    g.fillStyle(0xfff8e1, 0.08);
    g.fillCircle(16, 0, 18);
    // Bulb hint
    g.fillStyle(0xffeb3b, 0.4);
    g.fillCircle(16, 2, 3);
  }

  private drawWallClockGraphics(g: Phaser.GameObjects.Graphics) {
    const cx = 16,
      cy = 16,
      r = 14;
    // Shadow
    g.fillStyle(0x000000, 0.12);
    g.fillCircle(cx + 1, cy + 1, r + 1);
    // Frame
    g.fillStyle(0x5d4037, 1);
    g.fillCircle(cx, cy, r + 1);
    // Face
    g.fillStyle(0xfff8e1, 1);
    g.fillCircle(cx, cy, r - 1);
    // Hour markers
    g.fillStyle(0x333333, 0.8);
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2 - Math.PI / 2;
      const mx = cx + Math.cos(angle) * (r - 4);
      const my = cy + Math.sin(angle) * (r - 4);
      g.fillCircle(mx, my, i % 3 === 0 ? 1.5 : 0.8);
    }
    // Hour hand
    g.lineStyle(2, 0x333333, 1);
    g.lineBetween(cx, cy, cx + 5, cy - 4);
    // Minute hand
    g.lineStyle(1.5, 0x555555, 1);
    g.lineBetween(cx, cy, cx - 2, cy - 9);
    // Center dot
    g.fillStyle(0xc0392b, 1);
    g.fillCircle(cx, cy, 1.5);
    // Glass reflection
    g.fillStyle(0xffffff, 0.1);
    g.fillCircle(cx - 3, cy - 3, 5);
  }

  private drawCoatRackGraphics(g: Phaser.GameObjects.Graphics) {
    // Base
    g.fillStyle(0x5d4037, 1);
    g.fillCircle(16, 44, 7);
    g.fillStyle(0x6d4c41, 0.5);
    g.fillCircle(14, 42, 3);
    // Pole
    g.fillStyle(0x4e342e, 1);
    g.fillRect(14, 4, 4, 40);
    g.fillStyle(0x5d4037, 0.4);
    g.fillRect(15, 4, 1.5, 40);
    // Top knob
    g.fillStyle(0x3e2723, 1);
    g.fillCircle(16, 2, 4);
    g.fillStyle(0x5d4037, 0.3);
    g.fillCircle(15, 1, 1.5);
    // Hooks
    g.lineStyle(2, 0x4e342e, 1);
    // Left hook
    g.lineBetween(14, 10, 6, 10);
    g.lineBetween(6, 10, 6, 14);
    // Right hook
    g.lineBetween(18, 10, 26, 10);
    g.lineBetween(26, 10, 26, 14);
    // Middle hooks
    g.lineBetween(14, 18, 8, 18);
    g.lineBetween(8, 18, 8, 22);
    g.lineBetween(18, 18, 24, 18);
    g.lineBetween(24, 18, 24, 22);
    // Hanging jacket
    g.fillStyle(0x37474f, 0.7);
    g.fillRect(22, 14, 8, 14);
    g.fillStyle(0x455a64, 0.4);
    g.fillRect(23, 15, 3, 12);
    // Hanging hat on left
    g.fillStyle(0x8d6e63, 0.8);
    g.fillRect(2, 12, 8, 4);
    g.fillStyle(0x6d4c41, 1);
    g.fillRect(3, 10, 6, 3);
  }

  private drawSnackMachineGraphics(g: Phaser.GameObjects.Graphics) {
    // Shadow
    g.fillStyle(0x000000, 0.12);
    g.fillRect(3, 3, TILE + 4, TILE + 4);
    // Body
    g.fillStyle(0xc62828, 1);
    g.fillRect(0, 0, TILE, TILE);
    // Body highlight
    g.fillStyle(0xe53935, 0.3);
    g.fillRect(2, 2, 10, TILE - 4);
    // Glass window
    g.fillStyle(0x263238, 1);
    g.fillRect(4, 4, TILE - 16, TILE - 14);
    // Glass reflection
    g.fillStyle(0xffffff, 0.08);
    g.fillRect(5, 5, 10, TILE - 16);
    // Snack rows
    const snackColors = [0xffeb3b, 0x4caf50, 0x2196f3, 0xff9800, 0xe91e63];
    for (let row = 0; row < 3; row++) {
      // Shelf line
      g.fillStyle(P.coffeeMetal, 0.5);
      g.fillRect(5, 10 + row * 10, TILE - 18, 1);
      for (let col = 0; col < 3; col++) {
        g.fillStyle(snackColors[(row * 3 + col) % snackColors.length], 0.8);
        g.fillRect(6 + col * 9, 4 + row * 10, 7, 6);
      }
    }
    // Control panel (right side)
    g.fillStyle(0x424242, 1);
    g.fillRect(TILE - 12, 4, 10, TILE - 14);
    // Buttons
    g.fillStyle(0x76ff03, 0.6);
    g.fillRect(TILE - 10, 6, 6, 3);
    // Number pad
    for (let i = 0; i < 6; i++) {
      g.fillStyle(0x616161, 1);
      g.fillRect(TILE - 10 + (i % 2) * 4, 12 + Math.floor(i / 2) * 5, 3, 3);
    }
    // Coin slot
    g.fillStyle(P.coffeeMetal, 1);
    g.fillRect(TILE - 9, TILE - 12, 4, 6);
    g.fillStyle(0x333333, 1);
    g.fillRect(TILE - 8, TILE - 10, 2, 3);
    // Pickup slot
    g.fillStyle(0x1a1a1a, 1);
    g.fillRect(4, TILE - 8, TILE - 16, 6);
    // "SNACKS" label
    g.fillStyle(0xffeb3b, 0.7);
    g.fillRect(8, TILE - 2, 20, 2);
  }

  private drawCactusGraphics(g: Phaser.GameObjects.Graphics) {
    // Small terracotta pot
    g.fillStyle(0x000000, 0.08);
    g.fillCircle(16, 40, 8);
    g.fillStyle(0xbf6a3a, 1);
    g.fillRect(8, 30, 16, 14);
    g.fillStyle(0xd4844a, 1);
    g.fillRect(6, 28, 20, 4);
    g.fillStyle(0xd4844a, 0.3);
    g.fillRect(10, 32, 4, 10);
    // Soil
    g.fillStyle(0x3d2b1f, 1);
    g.fillRect(9, 28, 14, 3);
    // Main cactus body
    g.fillStyle(0x2d8a4e, 1);
    g.fillRoundedRect(12, 8, 8, 22, 3);
    // Cactus highlight
    g.fillStyle(0x3daa6e, 0.5);
    g.fillRect(13, 10, 3, 18);
    // Left arm
    g.fillStyle(0x2d8a4e, 1);
    g.fillRect(6, 14, 6, 5);
    g.fillRect(6, 10, 5, 6);
    g.fillStyle(0x3daa6e, 0.4);
    g.fillRect(7, 11, 2, 4);
    // Right arm
    g.fillStyle(0x2d8a4e, 1);
    g.fillRect(20, 18, 6, 5);
    g.fillRect(22, 14, 5, 6);
    g.fillStyle(0x3daa6e, 0.4);
    g.fillRect(23, 15, 2, 4);
    // Spines (tiny dots)
    g.fillStyle(0xc8e6c9, 0.5);
    const spinePositions = [
      [14, 10],
      [18, 12],
      [14, 16],
      [18, 20],
      [14, 24],
      [7, 12],
      [24, 16],
      [8, 16],
      [23, 20],
    ];
    for (const [sx, sy] of spinePositions) {
      g.fillCircle(sx, sy, 0.6);
    }
    // Flower on top
    g.fillStyle(0xff4081, 0.9);
    g.fillCircle(16, 7, 3);
    g.fillStyle(0xff80ab, 0.6);
    g.fillCircle(15, 6, 1.5);
    g.fillStyle(0xffeb3b, 1);
    g.fillCircle(16, 7, 1);
  }

  private drawTvGraphics(g: Phaser.GameObjects.Graphics) {
    const tw = TILE * 2 - 8;
    // Shadow
    g.fillStyle(0x000000, 0.12);
    g.fillRect(3, 3, tw, 30);
    // Bezel
    g.fillStyle(0x1a1a2e, 1);
    g.fillRect(0, 0, tw, 28);
    // Screen
    g.fillStyle(0x0a0a1a, 1);
    g.fillRect(3, 3, tw - 6, 20);
    // Screen content — chart/dashboard
    g.fillStyle(0x00d4ff, 0.5);
    g.fillRect(6, 6, 20, 1.5);
    g.fillRect(6, 9, 14, 1.5);
    // Bar chart
    const bars = [8, 14, 10, 16, 12, 18, 6];
    for (let i = 0; i < bars.length; i++) {
      g.fillStyle(i % 2 === 0 ? 0x00d4ff : 0x00ff88, 0.6);
      g.fillRect(6 + i * 10, 22 - bars[i], 7, bars[i]);
    }
    // Screen glow
    g.fillStyle(0x00d4ff, 0.05);
    g.fillCircle(tw / 2, 13, 20);
    // Stand
    g.fillStyle(0x333344, 1);
    g.fillRect(tw / 2 - 3, 28, 6, 4);
    g.fillRect(tw / 2 - 10, 31, 20, 3);
    // Power LED
    g.fillStyle(0x00ff00, 0.8);
    g.fillCircle(tw - 6, 25, 1);
  }

  private drawPingPongGraphics(g: Phaser.GameObjects.Graphics) {
    const tw = TILE * 2;
    // Shadow
    g.fillStyle(0x000000, 0.1);
    g.fillRect(4, 4, tw - 4, TILE - 4);
    // Table top
    g.fillStyle(0x1b5e20, 1);
    g.fillRect(0, 4, tw - 4, TILE - 12);
    // Table border
    g.lineStyle(2, 0xffffff, 0.8);
    g.strokeRect(1, 5, tw - 6, TILE - 14);
    // Center line
    g.lineStyle(1.5, 0xffffff, 0.8);
    g.lineBetween(tw / 2 - 2, 5, tw / 2 - 2, TILE - 9);
    // Net
    g.fillStyle(0x888888, 0.6);
    g.fillRect(tw / 2 - 3, 2, 2, TILE - 10);
    // Net posts
    g.fillStyle(0x666666, 1);
    g.fillRect(tw / 2 - 4, 4, 4, 3);
    g.fillRect(tw / 2 - 4, TILE - 11, 4, 3);
    // Legs
    g.fillStyle(0x333333, 1);
    g.fillRect(4, TILE - 8, 3, 8);
    g.fillRect(tw - 11, TILE - 8, 3, 8);
    g.fillRect(4, TILE - 4, 3, 4);
    g.fillRect(tw - 11, TILE - 4, 3, 4);
    // Ball
    g.fillStyle(0xff8f00, 1);
    g.fillCircle(tw / 2 + 12, 16, 2.5);
    g.fillStyle(0xffffff, 0.3);
    g.fillCircle(tw / 2 + 11, 15, 1);
    // Paddle
    g.fillStyle(0xc62828, 1);
    g.fillCircle(15, 20, 5);
    g.fillStyle(0x5d4037, 1);
    g.fillRect(13, 24, 4, 8);
  }

  private drawTrashCanGraphics(g: Phaser.GameObjects.Graphics) {
    // Shadow
    g.fillStyle(0x000000, 0.08);
    g.fillCircle(14, 40, 8);
    // Body
    g.fillStyle(0x607d8b, 1);
    g.fillRect(4, 12, 20, 28);
    // Slight taper
    g.fillStyle(0x546e7a, 1);
    g.fillRect(5, 14, 18, 24);
    // Rim
    g.fillStyle(0x78909c, 1);
    g.fillRect(3, 10, 22, 4);
    // Highlight
    g.fillStyle(0x90a4ae, 0.4);
    g.fillRect(6, 14, 4, 22);
    // Lid slightly ajar
    g.fillStyle(0x78909c, 1);
    g.fillRect(2, 8, 24, 3);
    g.fillStyle(0x90a4ae, 0.5);
    g.fillRect(3, 8, 22, 1.5);
    // Handle on lid
    g.fillStyle(0x546e7a, 1);
    g.fillRect(11, 5, 6, 4);
    g.fillStyle(0x78909c, 0.6);
    g.fillRect(12, 6, 4, 2);
    // Trash peeking out
    g.fillStyle(0xfdd835, 0.4);
    g.fillRect(8, 9, 5, 3);
    g.fillStyle(0xffffff, 0.3);
    g.fillRect(15, 8, 4, 3);
  }

  private drawServerRackGraphics(g: Phaser.GameObjects.Graphics) {
    // Shadow
    g.fillStyle(0x000000, 0.12);
    g.fillRect(3, 3, 30, TILE + 4);
    // Body
    g.fillStyle(0x263238, 1);
    g.fillRect(0, 0, 28, TILE);
    // Front panel
    g.fillStyle(0x37474f, 1);
    g.fillRect(2, 2, 24, TILE - 4);
    // Server units (4 rows)
    for (let i = 0; i < 4; i++) {
      const sy = 4 + i * 10;
      g.fillStyle(0x1a1a2e, 1);
      g.fillRect(3, sy, 22, 8);
      // Drive bays
      g.fillStyle(0x455a64, 0.6);
      for (let j = 0; j < 3; j++) {
        g.fillRect(4 + j * 7, sy + 1, 5, 6);
      }
      // Status LEDs
      g.fillStyle(i < 3 ? 0x00e676 : 0xff5722, 0.9);
      g.fillCircle(23, sy + 4, 1.2);
    }
    // Ventilation at top
    g.fillStyle(0x1a1a2e, 0.5);
    for (let i = 0; i < 4; i++) {
      g.fillRect(6 + i * 5, TILE - 6, 3, 3);
    }
    // Highlight edge
    g.fillStyle(0x546e7a, 0.3);
    g.fillRect(1, 1, 3, TILE - 2);
  }

  private drawFireExtinguisherGraphics(g: Phaser.GameObjects.Graphics) {
    // Wall bracket
    g.fillStyle(0x555555, 1);
    g.fillRect(10, 8, 12, 4);
    g.fillRect(10, 28, 12, 4);
    // Body
    g.fillStyle(0xc62828, 1);
    g.fillRoundedRect(10, 10, 12, 28, 3);
    // Body highlight
    g.fillStyle(0xe53935, 0.4);
    g.fillRect(11, 12, 4, 24);
    // Label
    g.fillStyle(0xffffff, 0.8);
    g.fillRect(12, 20, 8, 6);
    g.fillStyle(0xc62828, 0.5);
    g.fillRect(13, 21, 6, 1.5);
    g.fillRect(13, 23, 4, 1.5);
    // Top valve
    g.fillStyle(0x333333, 1);
    g.fillRect(12, 6, 8, 6);
    // Handle
    g.fillStyle(0x222222, 1);
    g.fillRect(20, 6, 6, 3);
    g.fillRect(23, 6, 3, 8);
    // Nozzle/hose
    g.fillStyle(0x111111, 1);
    g.fillRect(8, 8, 4, 2);
    g.fillRect(5, 8, 4, 14);
    g.fillRect(4, 20, 4, 3);
    // Pressure gauge
    g.fillStyle(0xffffff, 0.8);
    g.fillCircle(16, 9, 2.5);
    g.fillStyle(0x00e676, 0.6);
    g.fillCircle(16, 9, 1.5);
  }

  private drawUmbrellaStandGraphics(g: Phaser.GameObjects.Graphics) {
    // Shadow
    g.fillStyle(0x000000, 0.08);
    g.fillCircle(16, 42, 7);
    // Stand body (cylinder)
    g.fillStyle(0x5d4037, 1);
    g.fillRect(8, 22, 16, 22);
    // Rim
    g.fillStyle(0x6d4c41, 1);
    g.fillRect(6, 20, 20, 4);
    // Highlight
    g.fillStyle(0x8d6e63, 0.4);
    g.fillRect(10, 24, 4, 18);
    // Umbrella 1 — blue
    g.fillStyle(0x1565c0, 1);
    g.fillRect(11, 4, 3, 18);
    g.fillStyle(0x1976d2, 1);
    g.beginPath();
    g.moveTo(6, 6);
    g.lineTo(12, 2);
    g.lineTo(18, 6);
    g.closePath();
    g.fillPath();
    // Handle
    g.fillStyle(0x5d4037, 1);
    g.fillRect(10, 4, 2, 3);
    // Umbrella 2 — red (behind)
    g.fillStyle(0xc62828, 0.7);
    g.fillRect(17, 6, 2, 16);
    g.fillStyle(0xe53935, 0.6);
    g.beginPath();
    g.moveTo(13, 8);
    g.lineTo(18, 4);
    g.lineTo(23, 8);
    g.closePath();
    g.fillPath();
  }

  private drawMiniFridgeGraphics(g: Phaser.GameObjects.Graphics) {
    // Shadow
    g.fillStyle(0x000000, 0.1);
    g.fillRect(3, 3, 28, 38);
    // Body
    g.fillStyle(0xeceff1, 1);
    g.fillRect(0, 0, 26, 36);
    // Door panel
    g.fillStyle(0xe0e0e0, 1);
    g.fillRect(2, 2, 22, 32);
    // Door handle
    g.fillStyle(0xbdbdbd, 1);
    g.fillRect(20, 10, 3, 10);
    g.fillStyle(0xffffff, 0.3);
    g.fillRect(20, 11, 1.5, 8);
    // Door seal line
    g.lineStyle(1, 0xbdbdbd, 0.5);
    g.lineBetween(2, 16, 22, 16);
    // Top section (freezer)
    g.fillStyle(0xbbdefb, 0.3);
    g.fillRect(3, 3, 20, 12);
    // Bottom section
    g.fillStyle(0xffffff, 0.1);
    g.fillRect(3, 18, 20, 14);
    // Brand logo dot
    g.fillStyle(0x1976d2, 0.6);
    g.fillCircle(13, 28, 2);
    // Highlight
    g.fillStyle(0xffffff, 0.15);
    g.fillRect(3, 3, 5, 30);
    // Feet
    g.fillStyle(0x616161, 1);
    g.fillRect(2, 36, 4, 2);
    g.fillRect(20, 36, 4, 2);
  }

  private drawFanGraphics(g: Phaser.GameObjects.Graphics) {
    // Base
    g.fillStyle(0x455a64, 1);
    g.fillRect(6, 34, 20, 6);
    g.fillStyle(0x546e7a, 0.5);
    g.fillRect(8, 34, 16, 3);
    // Neck
    g.fillStyle(0x607d8b, 1);
    g.fillRect(14, 18, 4, 16);
    // Cage circle
    g.lineStyle(1.5, 0x78909c, 1);
    g.strokeCircle(16, 12, 12);
    // Cage grill lines
    g.lineStyle(0.8, 0x90a4ae, 0.5);
    for (let i = -10; i <= 10; i += 4) {
      const dx = Math.sqrt(144 - i * i);
      g.lineBetween(16 + i, 12 - dx, 16 + i, 12 + dx);
    }
    // Center hub
    g.fillStyle(0x455a64, 1);
    g.fillCircle(16, 12, 3);
    g.fillStyle(0x546e7a, 0.5);
    g.fillCircle(15, 11, 1.2);
    // Blades (3 blades)
    g.fillStyle(0xb0bec5, 0.6);
    for (let i = 0; i < 3; i++) {
      const angle = (i / 3) * Math.PI * 2 - Math.PI / 6;
      const bx = 16 + Math.cos(angle) * 8;
      const by = 12 + Math.sin(angle) * 8;
      g.beginPath();
      g.moveTo(16, 12);
      g.lineTo(bx - Math.sin(angle) * 3, by + Math.cos(angle) * 3);
      g.lineTo(bx + Math.sin(angle) * 3, by - Math.cos(angle) * 3);
      g.closePath();
      g.fillPath();
    }
    // Speed button
    g.fillStyle(0x00e676, 0.7);
    g.fillCircle(16, 38, 2);
  }

  // ── Agent sprites ──

  private fullRebuildAgents() {
    // Kill ALL tweens first to prevent stale references to destroyed objects
    this.tweens.killAll();
    // Destroy collaboration lines
    this.collaborationLines.forEach((g) => g.destroy());
    this.collaborationLines.clear();
    // Destroy agent containers
    this.agentSprites.forEach((c) => c.destroy());
    this.agentSprites.clear();
    this.thoughtBubbles.forEach((c) => c.destroy());
    this.thoughtBubbles.clear();
    this.agentAnimKeys.clear();
    this.agentSnapshot.clear();
    this.walkTimers.forEach((t) => t.destroy());
    this.walkTimers.clear();
    this.agentIndex = 0;

    this.assignDesks();

    for (const agent of this.agents) {
      this.createAgentSprite(agent);
    }
    this.scheduleIdleWalks();
  }

  private assignDesks() {
    const usedDesks = new Set<number>();
    for (const agent of this.agents) {
      if (agent.status !== "idle" && agent.status !== "collaborating") {
        let bestIdx = -1;
        let bestDist = Infinity;
        for (let i = 0; i < this.deskPositions.length; i++) {
          if (usedDesks.has(i)) continue;
          const d = this.deskPositions[i];
          const dist =
            Math.abs(d.x - agent.position.x) + Math.abs(d.y - agent.position.y);
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = i;
          }
        }
        if (bestIdx >= 0) {
          usedDesks.add(bestIdx);
          agent.position.x = this.deskPositions[bestIdx].x;
          agent.position.y = this.deskPositions[bestIdx].y;
        }
      }
    }
  }

  private destroyAgentSprite(id: string) {
    const container = this.agentSprites.get(id);
    if (container) {
      this.tweens.killTweensOf(container);
      container.getAll().forEach((child) => this.tweens.killTweensOf(child));
      container.destroy();
      this.agentSprites.delete(id);
    }
    this.hideThoughtBubble(id);
    const collabLine = this.collaborationLines.get(id);
    if (collabLine) {
      this.tweens.killTweensOf(collabLine);
      collabLine.destroy();
      this.collaborationLines.delete(id);
    }
    const timer = this.walkTimers.get(id);
    if (timer) {
      timer.destroy();
      this.walkTimers.delete(id);
    }
    this.agentAnimKeys.delete(id);
  }

  private statusToAnim(status: string): AnimState {
    switch (status) {
      case "thinking":
        return "think";
      case "working":
        return "type";
      case "speaking":
        return "type";
      case "collaborating":
        return "walk";
      case "background":
        return "type";
      default:
        return "idle";
    }
  }

  private createAgentSprite(agent: Agent) {
    const px = agent.position.x * TILE + TILE / 2;
    const py = agent.position.y * TILE + TILE / 2;

    const container = this.add.container(px, py);
    container.setDepth(10);
    container.setData("agentId", agent.id);

    // Drop shadow (visible always, subtle)
    const shadow = this.add.graphics();
    shadow.setName("shadow");
    shadow.fillStyle(0x000000, 0.15);
    shadow.fillEllipse(0, 20, 28, 8);
    container.add(shadow);

    // Selection highlight — soft glow ring
    const highlight = this.add.graphics();
    highlight.setName("highlight");
    highlight.fillStyle(0xffffff, 0.08);
    highlight.fillCircle(0, 0, 26);
    highlight.fillStyle(0xffffff, 0.12);
    highlight.fillCircle(0, 0, 20);
    highlight.setVisible(agent.id === this.selectedAgentId);
    container.add(highlight);

    // Generate sprite sheet from agent color
    const shirtColor = parseInt(agent.color.replace("#", ""), 16);
    const palette = buildPalette(shirtColor, this.agentIndex++);
    const animKeys = registerAgentTextures(this, agent.id, palette);
    this.agentAnimKeys.set(agent.id, animKeys);

    // Create animated sprite
    const animState = this.statusToAnim(agent.status);
    const sprite = this.add.sprite(0, -2, animKeys[animState]);
    sprite.setName("sprite");
    sprite.play(animKeys[animState]);
    container.add(sprite);

    // Name tag
    const nameText = this.add.text(0, 24, agent.name, {
      fontSize: "9px",
      fontFamily: '"SF Pro", "Segoe UI", system-ui, sans-serif',
      color: "#ffffff",
      stroke: "#000000",
      strokeThickness: 3,
      align: "center",
      fontStyle: "bold",
      resolution: window.devicePixelRatio,
    });
    nameText.setOrigin(0.5, 0);
    container.add(nameText);

    // Role text
    const roleText = this.add.text(0, 35, agent.role.slice(0, 30), {
      fontSize: "7px",
      fontFamily: '"SF Pro", "Segoe UI", system-ui, sans-serif',
      color: "#ffffff",
      stroke: "#000000",
      strokeThickness: 3,
      align: "center",
      resolution: window.devicePixelRatio,
    });
    roleText.setOrigin(0.5, 0);
    container.add(roleText);

    // Status indicator
    const statusColor =
      agent.status === "thinking"
        ? 0xf39c12
        : agent.status === "working"
          ? 0x2ecc71
          : agent.status === "speaking"
            ? 0x3498db
            : agent.status === "collaborating"
              ? 0x9b59b6
              : agent.status === "waiting-approval"
                ? 0xeab308
                : agent.status === "waiting-input"
                  ? 0xf97316
                  : agent.status === "slow"
                    ? 0xeab308
                    : agent.status === "stuck"
                      ? 0xef4444
                      : 0x7f8c8d;
    const statusGfx = this.add.graphics();
    statusGfx.setName("statusDot");
    statusGfx.fillStyle(0x000000, 0.3);
    statusGfx.fillCircle(16, -22, 6);
    statusGfx.fillStyle(statusColor, 1);
    statusGfx.fillCircle(16, -22, 4.5);
    statusGfx.fillStyle(0xffffff, 0.3);
    statusGfx.fillCircle(15, -23, 2);
    container.add(statusGfx);

    if (agent.status !== "idle") {
      this.tweens.add({
        targets: statusGfx,
        scaleX: 1.3,
        scaleY: 1.3,
        duration: 600,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
    }

    // Interaction — click + drag
    container.setSize(TILE, TILE);
    container.setInteractive({ cursor: "grab", draggable: true });
    this.input.setDraggable(container);

    container.on("pointerdown", () => {
      if (this.onAgentClick) this.onAgentClick(agent);
    });
    container.on("pointerover", () => {
      if (!this.isDragging) {
        this.tweens.add({
          targets: container,
          scaleX: 1.08,
          scaleY: 1.08,
          duration: 150,
          ease: "Back.easeOut",
        });
        if (agent.currentThought) this.showThoughtBubble(agent, container);
      }
    });
    container.on("pointerout", () => {
      if (!this.isDragging || this.dragTarget !== container) {
        this.tweens.add({
          targets: container,
          scaleX: 1,
          scaleY: 1,
          duration: 150,
          ease: "Quad.easeOut",
        });
        this.hideThoughtBubble(agent.id);
      }
    });

    // Idle bob animation
    if (agent.status === "idle") {
      this.startIdleBob(container, py);
    }

    this.agentSprites.set(agent.id, container);

    this.agentSnapshot.set(agent.id, {
      status: agent.status,
      name: agent.name,
      role: agent.role,
      color: agent.color,
      thought: agent.currentThought ?? "",
      collaboratingWith: agent.collaboratingWith,
    });
  }

  // ── Thought bubbles ──

  private showThoughtBubble(
    agent: Agent,
    _container: Phaser.GameObjects.Container,
  ) {
    this.hideThoughtBubble(agent.id);
    if (!agent.currentThought) return;

    const px = agent.position.x * TILE + TILE / 2;
    const py = agent.position.y * TILE;

    const bubble = this.add.container(px, py - 44);
    bubble.setDepth(25);

    // Strip emojis and non-ASCII characters that Phaser can't render, then truncate
    const rawThought = agent.currentThought
      .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")  // supplementary symbols
      .replace(/[\u{2600}-\u{27BF}]/gu, "")     // misc symbols
      .replace(/[\u{FE00}-\u{FE0F}]/gu, "")     // variation selectors
      .replace(/[\u{200D}]/gu, "")               // zero-width joiner
      .replace(/^\s+/, "")
      .trim();
    if (!rawThought) return;
    const displayThought = rawThought.length > 45 ? rawThought.slice(0, 42) + "..." : rawThought;

    const maxW = 140;
    const padX = 8;
    const padY = 6;

    // Create text with a fixed wordWrap width so Phaser wraps correctly
    const wrapWidth = maxW - padX * 2;
    const text = this.add.text(0, 0, displayThought, {
      fontSize: "9px",
      fontFamily: '"SF Pro", "Segoe UI", system-ui, sans-serif',
      color: "#1a1a2e",
      wordWrap: { width: wrapWidth, useAdvancedWrap: true },
      align: "center",
      lineSpacing: 2,
      resolution: window.devicePixelRatio,
      fixedWidth: wrapWidth,
    });

    // Use fixedWidth for consistent sizing; height from actual render
    const tw = wrapWidth + padX * 2;
    const th = text.height + padY * 2;

    // Position text centered within the bubble
    text.setPosition(-tw / 2 + padX, -th + padY);

    const bg = this.add.graphics();
    // Drop shadow
    bg.fillStyle(0x000000, 0.12);
    bg.fillRoundedRect(-tw / 2 + 2, -th + 2, tw, th, 8);
    // White bubble
    bg.fillStyle(0xffffff, 0.96);
    bg.fillRoundedRect(-tw / 2, -th, tw, th, 8);
    bg.lineStyle(1.5, 0xcccccc, 0.8);
    bg.strokeRoundedRect(-tw / 2, -th, tw, th, 8);
    // Tail dots
    bg.fillStyle(0xffffff, 0.96);
    bg.fillCircle(0, 4, 4);
    bg.fillCircle(-3, 10, 2.5);
    bg.fillCircle(-5, 15, 1.5);

    bubble.add(bg);
    bubble.add(text);

    bubble.setAlpha(0);
    this.tweens.add({
      targets: bubble,
      alpha: 1,
      y: py - 48,
      duration: 200,
      ease: "Back.easeOut",
    });

    this.thoughtBubbles.set(agent.id, bubble);
  }

  private hideThoughtBubble(agentId: string) {
    const b = this.thoughtBubbles.get(agentId);
    if (b) {
      b.destroy();
      this.thoughtBubbles.delete(agentId);
    }
  }

  // ── Status transitions ──

  private transitionAgentStatus(agent: Agent) {
    const container = this.agentSprites.get(agent.id);
    if (!container) return;

    this.tweens.killTweensOf(container);
    container.getAll().forEach((child) => this.tweens.killTweensOf(child));

    const timer = this.walkTimers.get(agent.id);
    if (timer) {
      timer.destroy();
      this.walkTimers.delete(agent.id);
    }

    const animKeys = this.agentAnimKeys.get(agent.id);
    const sprite = container.getByName(
      "sprite",
    ) as Phaser.GameObjects.Sprite | null;
    if (sprite && animKeys) {
      const animState = this.statusToAnim(agent.status);
      sprite.play(animKeys[animState]);
    }

    // Update status dot
    const oldStatusGfx = container.getByName(
      "statusDot",
    ) as Phaser.GameObjects.Graphics | null;
    if (oldStatusGfx) {
      oldStatusGfx.destroy();
    }
    const statusColor =
      agent.status === "thinking"
        ? 0xf39c12
        : agent.status === "working"
          ? 0x2ecc71
          : agent.status === "speaking"
            ? 0x3498db
            : agent.status === "collaborating"
              ? 0x9b59b6
              : agent.status === "waiting-approval"
                ? 0xeab308
                : agent.status === "waiting-input"
                  ? 0xf97316
                  : agent.status === "slow"
                    ? 0xeab308
                    : agent.status === "stuck"
                      ? 0xef4444
                      : 0x7f8c8d;
    const statusGfx = this.add.graphics();
    statusGfx.setName("statusDot");
    statusGfx.fillStyle(0x000000, 0.3);
    statusGfx.fillCircle(16, -22, 6);
    statusGfx.fillStyle(statusColor, 1);
    statusGfx.fillCircle(16, -22, 4.5);
    statusGfx.fillStyle(0xffffff, 0.3);
    statusGfx.fillCircle(15, -23, 2);
    container.add(statusGfx);

    if (agent.status !== "idle") {
      this.tweens.add({
        targets: statusGfx,
        scaleX: 1.3,
        scaleY: 1.3,
        duration: 600,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
    }

    // Clean up collaboration line
    const oldLine = this.collaborationLines.get(agent.id);
    if (oldLine) {
      oldLine.destroy();
      this.collaborationLines.delete(agent.id);
    }

    let targetX: number;
    let targetY: number;

    if (agent.status === "collaborating" && agent.collaboratingWith) {
      const targetAgent = this.agents.find(
        (a) => a.id === agent.collaboratingWith,
      );
      if (targetAgent) {
        targetX = targetAgent.position.x * TILE + TILE / 2 + TILE * 0.6;
        targetY = targetAgent.position.y * TILE + TILE / 2;
      } else {
        targetX = agent.position.x * TILE + TILE / 2;
        targetY = agent.position.y * TILE + TILE / 2;
      }
    } else {
      targetX = agent.position.x * TILE + TILE / 2;
      targetY = agent.position.y * TILE + TILE / 2;
    }

    const dx = Math.abs(container.x - targetX);
    const dy = Math.abs(container.y - targetY);
    const distance = Math.sqrt(dx * dx + dy * dy);
    const moveDuration = Math.max(400, Math.min(1500, distance * 4));

    if (sprite && animKeys && distance > 4) {
      sprite.play(animKeys.walk);
    }

    this.tweens.add({
      targets: container,
      x: targetX,
      y: targetY,
      duration: moveDuration,
      ease: "Sine.easeInOut",
      onComplete: () => {
        if (sprite && animKeys) {
          const animState = this.statusToAnim(agent.status);
          sprite.play(animKeys[animState]);
        }
        if (agent.status === "idle") {
          this.startIdleBob(container, targetY);
          this.scheduleWalk(agent.id);
          this.hideThoughtBubble(agent.id);
        } else if (agent.currentThought) {
          // Show thought bubble when agent arrives at desk and is working
          this.hideThoughtBubble(agent.id);
          this.showThoughtBubble(agent, container);
        }
        if (agent.status === "collaborating" && agent.collaboratingWith) {
          this.drawCollaborationLine(agent.id, agent.collaboratingWith);
        }
      },
    });

    this.agentSnapshot.set(agent.id, {
      status: agent.status,
      name: agent.name,
      role: agent.role,
      color: agent.color,
      thought: agent.currentThought ?? "",
      collaboratingWith: agent.collaboratingWith,
    });
  }

  private drawCollaborationLine(fromId: string, toId: string) {
    const fromContainer = this.agentSprites.get(fromId);
    const toContainer = this.agentSprites.get(toId);
    if (!fromContainer || !toContainer) return;

    const gfx = this.add.graphics();
    gfx.lineStyle(2, 0x9b59b6, 0.5);

    const x1 = fromContainer.x;
    const y1 = fromContainer.y - 10;
    const x2 = toContainer.x;
    const y2 = toContainer.y - 10;
    const segments = 8;
    for (let i = 0; i < segments; i += 2) {
      const t1 = i / segments;
      const t2 = (i + 1) / segments;
      gfx.beginPath();
      gfx.moveTo(x1 + (x2 - x1) * t1, y1 + (y2 - y1) * t1);
      gfx.lineTo(x1 + (x2 - x1) * t2, y1 + (y2 - y1) * t2);
      gfx.strokePath();
    }

    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2 - 8;
    gfx.fillStyle(0x9b59b6, 0.7);
    gfx.fillRoundedRect(mx - 8, my - 6, 16, 12, 3);
    gfx.fillTriangle(mx - 2, my + 6, mx + 2, my + 6, mx, my + 10);
    gfx.fillStyle(0xffffff, 0.9);
    gfx.fillCircle(mx - 3, my, 1.5);
    gfx.fillCircle(mx, my, 1.5);
    gfx.fillCircle(mx + 3, my, 1.5);

    this.tweens.add({
      targets: gfx,
      alpha: { from: 0.4, to: 1 },
      duration: 800,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });

    this.collaborationLines.set(fromId, gfx);
  }

  // ── Idle behaviors ──

  private startIdleBob(container: Phaser.GameObjects.Container, baseY: number) {
    this.tweens.add({
      targets: container,
      y: baseY - 2,
      duration: 1200 + Math.random() * 600,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
      delay: Math.random() * 500,
    });
  }

  private scheduleIdleWalks() {
    for (const agent of this.agents) {
      this.scheduleWalk(agent.id);
    }
  }

  private scheduleWalk(agentId: string) {
    const delay = 5000 + Math.random() * 10000;
    const timer = this.time.delayedCall(delay, () => {
      const agent = this.agents.find((a) => a.id === agentId);
      if (!agent || agent.status !== "idle") {
        this.scheduleWalk(agentId);
        return;
      }
      const dx = Math.floor(Math.random() * 3) - 1;
      const dy = Math.floor(Math.random() * 3) - 1;
      if (dx === 0 && dy === 0) {
        this.scheduleWalk(agentId);
        return;
      }
      const nx = Math.max(0, Math.min(this.cols - 1, agent.position.x + dx));
      const ny = Math.max(0, Math.min(this.rows - 1, agent.position.y + dy));
      this.agentTargets.set(agentId, { x: nx, y: ny });

      const container = this.agentSprites.get(agentId);
      if (container) {
        this.tweens.killTweensOf(container);

        const animKeys = this.agentAnimKeys.get(agentId);
        const sprite = container.getByName(
          "sprite",
        ) as Phaser.GameObjects.Sprite | null;
        if (sprite && animKeys) {
          sprite.play(animKeys.walk);
        }

        const targetX = nx * TILE + TILE / 2;
        const targetY = ny * TILE + TILE / 2;

        this.tweens.add({
          targets: container,
          x: targetX,
          y: targetY,
          duration: 1000 + Math.random() * 500,
          ease: "Sine.easeInOut",
          onComplete: () => {
            if (sprite && animKeys) {
              sprite.play(animKeys.idle);
            }
            agent.position.x = nx;
            agent.position.y = ny;
            this.startIdleBob(container, targetY);
            this.scheduleWalk(agentId);
          },
        });
      } else {
        this.scheduleWalk(agentId);
      }
    });
    this.walkTimers.set(agentId, timer);
  }

  // ── Ambient dust particles ──

  private initDustParticles() {
    if (this.dustGraphics) this.dustGraphics.destroy();
    this.dustGraphics = this.add.graphics();
    this.dustGraphics.setDepth(3);
    this.dustMotes = [];

    const H = this.scale.gameSize.height;
    for (const zone of this.windowBeamZones) {
      for (let i = 0; i < 6; i++) {
        this.dustMotes.push({
          x: zone.x + (Math.random() - 0.5) * zone.w,
          y: zone.y1 + Math.random() * (H - zone.y1),
          vx: (Math.random() - 0.5) * 0.15,
          vy: -0.08 - Math.random() * 0.12,
          alpha: 0.15 + Math.random() * 0.25,
          size: 1 + Math.random() * 1.5,
          life: Math.random() * 8000,
          maxLife: 6000 + Math.random() * 6000,
        });
      }
    }

    const W = this.scale.gameSize.width;
    for (let i = 0; i < 10; i++) {
      this.dustMotes.push({
        x: Math.random() * W,
        y: TILE * 2 + Math.random() * (H - TILE * 3),
        vx: (Math.random() - 0.5) * 0.1,
        vy: (Math.random() - 0.5) * 0.05,
        alpha: 0.06 + Math.random() * 0.1,
        size: 0.8 + Math.random() * 1,
        life: Math.random() * 10000,
        maxLife: 8000 + Math.random() * 8000,
      });
    }
  }

  private updateDustParticles(delta: number) {
    if (!this.dustGraphics || this.dustMotes.length === 0) return;

    this.dustGraphics.clear();
    const H = this.scale.gameSize.height;
    const W = this.scale.gameSize.width;

    for (const mote of this.dustMotes) {
      mote.life += delta;
      mote.x += mote.vx * (delta / 16);
      mote.y += mote.vy * (delta / 16);
      mote.x += Math.sin(mote.life * 0.001) * 0.03;

      const lifeRatio = mote.life / mote.maxLife;
      let fadeAlpha = mote.alpha;
      if (lifeRatio < 0.1) fadeAlpha *= lifeRatio / 0.1;
      else if (lifeRatio > 0.8) fadeAlpha *= (1 - lifeRatio) / 0.2;

      this.dustGraphics.fillStyle(0xfff8e1, fadeAlpha);
      this.dustGraphics.fillCircle(mote.x, mote.y, mote.size);

      if (
        mote.life >= mote.maxLife ||
        mote.y < TILE ||
        mote.y > H ||
        mote.x < 0 ||
        mote.x > W
      ) {
        if (this.windowBeamZones.length > 0 && Math.random() < 0.7) {
          const zone =
            this.windowBeamZones[
              Math.floor(Math.random() * this.windowBeamZones.length)
            ];
          mote.x = zone.x + (Math.random() - 0.5) * zone.w;
          mote.y = zone.y1 + Math.random() * (H - zone.y1);
        } else {
          mote.x = Math.random() * W;
          mote.y = TILE * 2 + Math.random() * (H - TILE * 3);
        }
        mote.life = 0;
        mote.maxLife = 6000 + Math.random() * 6000;
        mote.vx = (Math.random() - 0.5) * 0.15;
        mote.vy = -0.08 - Math.random() * 0.12;
      }
    }
  }
}
