import Phaser from "phaser";
import { Agent, AGENT_COLORS } from "../lib/types";
import {
  buildPalette,
  registerAgentTextures,
  registerAgentFromSheet,
  loadSpriteSheetImage,
  FRAME_PX,
  AnimState,
} from "./SpriteGen";
import {
  type AssetPack,
  type FurnitureItemConfig,
  getActivePack,
  listAssetPacks,
  resolveEmployeeSheetUrl,
  normalizeFurnitureItem,
  furnitureItemUrl,
} from "../lib/assetPack";
import { P, TILE, drawBuiltinFurniture } from "./FurnitureGen";

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

export type BuiltinFurnitureType =
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

export interface FurnitureItem {
  id: string;
  type: BuiltinFurnitureType | string; // string for custom types from packs
  x: number; // tile x
  y: number; // tile y
  rotation?: number; // 0, 90, 180, 270
  custom?: boolean; // true = from asset pack
  customKey?: string; // key into pack furniture items (may be "packId:key" or legacy bare key)
  packId?: string; // asset pack this item came from (absent on legacy items)
  isDesk?: boolean; // true = agents work here (for custom furniture)
  removed?: boolean; // tombstone: default item was deleted by user
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
      spriteSheet: string;
    }
  > = new Map();
  private collaborationLines: Map<string, Phaser.GameObjects.Graphics> =
    new Map();
  private resizeTimer?: ReturnType<typeof setTimeout>;
  /** True while rebuildAll is executing — guards against concurrent persistence. */
  private rebuilding = false;
  /** True while WebGL context is lost — skip all draw operations. */
  private contextLost = false;

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

  // ── Removed default furniture (persisted so they don't respawn on rebuild) ──
  private removedFurnitureIds: Set<string> = new Set();

  // ── Asset pack ──
  private activePack: AssetPack | null = null;
  private cachedSheets: Map<string, HTMLCanvasElement> = new Map();
  private cachedFurniture: Map<string, HTMLCanvasElement> = new Map();
  private furnitureConfigs: Map<string, FurnitureItemConfig & { desk: boolean }> = new Map();
  private cachedBackground: HTMLCanvasElement | null = null;
  private backgroundMode: "stretch" | "tile" | "cover" = "cover";

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
    // Derive removed default furniture: IDs explicitly marked as removed
    this.removedFurnitureIds = new Set(
      (layout as (FurnitureItem & { removed?: boolean })[])
        .filter((f) => f.removed)
        .map((f) => f.id),
    );
  }

  preload() {
    // All graphics are procedurally generated — no external assets needed
  }

  /** Load the active asset pack (if any) and pre-fetch its sprite sheets.
   *  Furniture is loaded from ALL installed packs so items can be mixed. */
  async loadAssetPack(): Promise<void> {
    try {
      const activeId = await getActivePack();
      const packs = await listAssetPacks();

      // ── Active pack: employees + background ──
      if (!activeId) {
        this.activePack = null;
        this.cachedSheets.clear();
        this.cachedBackground = null;
      } else {
        const pack = packs.find((p) => p.id === activeId) ?? null;
        if (!pack?.manifest.categories.employees) {
          this.activePack = null;
          this.cachedSheets.clear();
          this.cachedBackground = null;
        } else {
          this.activePack = pack;
          // Pre-fetch all employee sheets
          const sheets = pack.manifest.categories.employees.sheets;
          const entries = Object.entries(sheets);
          const loaded = await Promise.all(
            entries.map(async ([role, relPath]) => {
              const url = `user-assets://${encodeURIComponent(pack.id)}/${relPath.split("/").map(encodeURIComponent).join("/")}`;
              try {
                const canvas = await loadSpriteSheetImage(url);
                return [role, canvas] as const;
              } catch {
                console.warn(`[assets] Failed to load sheet: ${url}`);
                return null;
              }
            }),
          );
          this.cachedSheets.clear();
          for (const entry of loaded) {
            if (entry) this.cachedSheets.set(entry[0], entry[1]);
          }

          // Pre-fetch background image
          this.cachedBackground = null;
          const bgCat = pack.manifest.categories.background;
          if (bgCat) {
            const bgConfig = typeof bgCat === "string" ? { file: bgCat } : bgCat;
            this.backgroundMode = bgConfig.mode ?? "cover";
            const bgUrl = `user-assets://${encodeURIComponent(pack.id)}/${bgConfig.file.split("/").map(encodeURIComponent).join("/")}`;
            try {
              this.cachedBackground = await loadSpriteSheetImage(bgUrl);
            } catch {
              console.warn(`[assets] Failed to load background: ${bgUrl}`);
            }
          }
        }
      }

      // ── Furniture: load from ALL packs ──
      this.cachedFurniture.clear();
      this.furnitureConfigs.clear();
      for (const p of packs) {
        const furnitureCat = p.manifest.categories.furniture;
        if (!furnitureCat) continue;
        const furEntries = Object.entries(furnitureCat.items);
        const furLoaded = await Promise.all(
          furEntries.map(async ([key, entry]) => {
            const config = normalizeFurnitureItem(key, entry);
            const url = furnitureItemUrl(p.id, config);
            try {
              const canvas = await loadSpriteSheetImage(url);
              return [key, canvas, config] as const;
            } catch {
              console.warn(`[assets] Failed to load furniture: ${url}`);
              return null;
            }
          }),
        );
        for (const entry of furLoaded) {
          if (entry) {
            const nsKey = `${p.id}:${entry[0]}`;
            this.cachedFurniture.set(nsKey, entry[1]);
            this.furnitureConfigs.set(nsKey, entry[2]);
            // Also register under the bare key for backward compat with
            // saved layouts that pre-date the packId:key format.
            // Last-write-wins — the active pack takes priority (loaded last below).
            if (p.id !== activeId) {
              if (!this.cachedFurniture.has(entry[0])) {
                this.cachedFurniture.set(entry[0], entry[1]);
                this.furnitureConfigs.set(entry[0], entry[2]);
              }
            }
          }
        }
      }
      // Active pack bare keys win over other packs for backward compat
      if (activeId) {
        const activeFurn = packs.find((p) => p.id === activeId)?.manifest.categories.furniture;
        if (activeFurn) {
          for (const [key] of Object.entries(activeFurn.items)) {
            const nsKey = `${activeId}:${key}`;
            const canvas = this.cachedFurniture.get(nsKey);
            const config = this.furnitureConfigs.get(nsKey);
            if (canvas) {
              this.cachedFurniture.set(key, canvas);
              if (config) this.furnitureConfigs.set(key, config);
            }
          }
        }
      }
    } catch (err) {
      console.warn("[assets] Failed to load asset pack:", err);
      this.activePack = null;
      this.cachedSheets.clear();
      this.cachedFurniture.clear();
      this.furnitureConfigs.clear();
      this.cachedBackground = null;
    }
  }

  create() {
    this.computeGrid();
    this.drawOffice();
    this.createAllFurniture();
    this.initDustParticles();
    this.ready = true;

    // Load asset pack in the background — re-render agents and restore
    // custom furniture once pack images are cached (furniture from ALL packs).
    this.loadAssetPack().then(() => {
      // If a rebuild is in progress, skip — rebuildAll will handle everything.
      if (this.rebuilding) return;
      // Restore custom pack furniture that couldn't load earlier (cache was empty)
      if (this.savedLayout && this.cachedFurniture.size > 0) {
        let added = false;
        for (const item of this.savedLayout) {
          if (!item.custom || !item.customKey || this.furnitureContainers.has(item.id)) continue;
          const resolvedKey = this.resolveFurnitureKey(item.customKey, item.packId);
          if (!resolvedKey) continue;
          const config = this.furnitureConfigs.get(resolvedKey);
          this.createFurnitureContainer(item.id, item.type, item.x, item.y, {
            custom: true,
            customKey: resolvedKey,
            packId: item.packId ?? this.packIdFromKey(resolvedKey),
            isDesk: item.isDesk ?? config?.desk ?? false,
            rotation: item.rotation,
          });
          added = true;
        }
        if (added) {
          this.rebuildDeskPositions();
          this.persistFurniture();
        }
      }
      if (this.activePack && this.agentSprites.size > 0) {
        this.fullRebuildAgents();
      }
    });

    // Dismiss furniture edit on click outside
    this.input.on("pointerdown", (_pointer: Phaser.Input.Pointer, targets: Phaser.GameObjects.GameObject[]) => {
      if (!this.editingFurnitureId) return;
      const editContainer = this.furnitureContainers.get(this.editingFurnitureId);
      const isOnOverlay = targets.some((t) => this.editOverlayObjects.includes(t));
      const isOnFurniture = targets.includes(editContainer!);
      if (!isOnOverlay && !isOnFurniture) {
        this.dismissFurnitureEdit();
      }
    });

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
        this.dismissFurnitureEdit();
        if (this.longPressTimer) {
          clearTimeout(this.longPressTimer);
          this.longPressTimer = undefined;
        }
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
            if (item.type === 'desk' || item.isDesk) {
              this.rebuildDeskPositions();
              this.assignDesks();
              // Re-walk any working agents to their (possibly new) desk
              for (const agent of this.agents) {
                if (agent.status !== 'idle' && agent.status !== 'collaborating') {
                  this.transitionAgentStatus(agent);
                }
              }
            }
            this.persistFurniture();
          }
        }
      },
    );

    this.scale.on("resize", () => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        if (!this.scene.isActive() || !this.sys.game || this.contextLost) return;
        // Skip rebuild if canvas is too small — will retry on next resize
        const w = this.scale.gameSize.width;
        const h = this.scale.gameSize.height;
        if (w < 100 || h < 100) return;
        this.rebuildAll();
      }, 150);
    });

    // Recover from WebGL context loss (e.g. canvas temporarily resized to 0)
    const canvas = this.sys.game.canvas;
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault(); // allow context to be restored
      this.contextLost = true;
    });
    canvas.addEventListener("webglcontextrestored", () => {
      this.contextLost = false;
      if (this.scene.isActive() && this.sys.game) {
        this.rebuildAll();
      }
    });

    // Render any agents that were set before create() fired
    if (this.agents.length > 0) {
      this.fullRebuildAgents();
    }

    // Hot-swap asset pack when user changes it in the UI
    const onPackChanged = () => {
      this.loadAssetPack().then(() => {
        // Rebuild the full scene to apply background + sprite changes
        this.rebuildAll();
      });
    };
    window.addEventListener("asset-pack-changed", onPackChanged);

    // Add/remove custom furniture from the Assets modal
    const onFurnitureAdd = (e: Event) => {
      const { key } = (e as CustomEvent).detail;
      this.addFurniture(key);
    };
    const onFurnitureRemove = (e: Event) => {
      const { id } = (e as CustomEvent).detail;
      this.removeFurniture(id);
    };
    window.addEventListener("furniture-add", onFurnitureAdd);
    window.addEventListener("furniture-remove", onFurnitureRemove);

    this.events.on("shutdown", () => {
      if (this.resizeTimer) {
        clearTimeout(this.resizeTimer);
        this.resizeTimer = undefined;
      }
      window.removeEventListener("asset-pack-changed", onPackChanged);
      window.removeEventListener("furniture-add", onFurnitureAdd);
      window.removeEventListener("furniture-remove", onFurnitureRemove);
    });
  }

  update(_time: number, delta: number) {
    this.updateDustParticles(delta);
  }

  /** Tear down all scene visuals and rebuild from scratch (used on resize) */
  private rebuildAll() {
    // Don't attempt to draw while the WebGL context is lost
    if (this.contextLost) return;

    this.rebuilding = true;
    try {
      // Dismiss any active furniture edit overlay
      this.dismissFurnitureEdit();

      // ── Destroy everything ──
      // Background graphics (lights, dead zone, etc.)
      for (const obj of this.bgObjects) {
        try { obj.destroy(); } catch { /* already destroyed */ }
      }
      this.bgObjects = [];
      // Main office floor/walls
      if (this.officeGraphics) {
        this.officeGraphics.destroy();
        this.officeGraphics = undefined;
      }
      // Furniture
      this.furnitureContainers.forEach((c) => {
        try { c.destroy(); } catch { /* already destroyed */ }
      });
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
      // Merge current furniture positions into savedLayout so that
      // user-moved items keep their positions, while tombstones and
      // not-yet-rendered custom items from the original layout survive.
      if (this.furnitureItems.length > 0) {
        const currentById = new Map(this.furnitureItems.map((f) => [f.id, f]));
        if (this.savedLayout) {
          // Update positions for items that exist in the current scene
          this.savedLayout = this.savedLayout.map((saved) => {
            const current = currentById.get(saved.id);
            return current ?? saved; // keep tombstones & unrendered items as-is
          });
          // Add any items that are in furnitureItems but not in savedLayout
          // (e.g. user-added items since last load)
          const savedIds = new Set(this.savedLayout.map((f) => f.id));
          for (const item of this.furnitureItems) {
            if (!savedIds.has(item.id)) {
              this.savedLayout.push(item);
            }
          }
        } else {
          this.savedLayout = [...this.furnitureItems];
        }
      }
      this.drawOffice();
      this.createAllFurniture();
      this.initDustParticles();
      if (this.agents.length > 0) {
        this.fullRebuildAgents();
      }
    } catch (err) {
      console.error("[OfficeScene] rebuildAll failed, retrying:", err);
      // Schedule a recovery rebuild
      setTimeout(() => {
        if (this.scene.isActive() && this.sys.game && !this.contextLost) {
          try {
            this.computeGrid();
            this.drawOffice();
            this.createAllFurniture();
            this.initDustParticles();
            if (this.agents.length > 0) {
              this.fullRebuildAgents();
            }
          } catch (retryErr) {
            console.error("[OfficeScene] recovery rebuild also failed:", retryErr);
          }
        }
      }, 500);
    } finally {
      this.rebuilding = false;
    }
  }

  // ── Public API ──

  /** All known builtin furniture types. */
  static readonly BUILTIN_FURNITURE: { type: BuiltinFurnitureType; label: string; isDesk?: boolean }[] = [
    { type: "desk", label: "Desk", isDesk: true },
    { type: "plant", label: "Plant" },
    { type: "whiteboard", label: "Whiteboard" },
    { type: "bookshelf", label: "Bookshelf" },
    { type: "coffee-machine", label: "Coffee Machine" },
    { type: "water-cooler", label: "Water Cooler" },
    { type: "printer", label: "Printer" },
    { type: "filing-cabinet", label: "Filing Cabinet" },
    { type: "couch", label: "Couch" },
    { type: "standing-lamp", label: "Standing Lamp" },
    { type: "wall-clock", label: "Wall Clock" },
    { type: "coat-rack", label: "Coat Rack" },
    { type: "snack-machine", label: "Snack Machine" },
    { type: "cactus", label: "Cactus" },
    { type: "tv", label: "TV" },
    { type: "ping-pong", label: "Ping Pong" },
    { type: "trash-can", label: "Trash Can" },
    { type: "server-rack", label: "Server Rack" },
    { type: "fire-extinguisher", label: "Fire Extinguisher" },
    { type: "umbrella-stand", label: "Umbrella Stand" },
    { type: "mini-fridge", label: "Mini Fridge" },
    { type: "fan", label: "Fan" },
  ];

  /** Add furniture to the office — works for both builtin types and custom pack items.
   *  For pack items, `key` may be "packId:itemKey" (namespaced) or a bare key. */
  addFurniture(key: string) {
    const id = `added-${key}-${Date.now()}`;
    const tileX = Math.floor(this.cols / 2);
    const tileY = Math.floor(this.rows / 2);

    // Check if it's a custom pack item (try namespaced key first, then bare)
    if (this.cachedFurniture.has(key)) {
      const config = this.furnitureConfigs.get(key);
      // Extract packId from namespaced key ("packId:itemKey")
      const colonIdx = key.indexOf(":");
      const packId = colonIdx >= 0 ? key.slice(0, colonIdx) : undefined;
      this.createFurnitureContainer(id, key, tileX, tileY, {
        custom: true,
        customKey: key,
        packId,
        isDesk: config?.desk ?? false,
      });
    } else {
      // Builtin type
      const builtin = OfficeScene.BUILTIN_FURNITURE.find((b) => b.type === key);
      this.createFurnitureContainer(id, key as BuiltinFurnitureType, tileX, tileY, {
        isDesk: builtin?.isDesk,
      });
    }
    this.rebuildDeskPositions();
    this.persistFurniture();
  }

  /** Remove a furniture item by ID (works for defaults, added builtins, and custom). */
  removeFurniture(id: string) {
    const container = this.furnitureContainers.get(id);
    if (container) {
      container.destroy();
      this.furnitureContainers.delete(id);
    }
    const isDefault = !id.startsWith("added-") && !id.startsWith("custom-");
    if (isDefault) {
      this.removedFurnitureIds.add(id);
    }
    this.furnitureItems = this.furnitureItems.filter((f) => f.id !== id);
    this.rebuildDeskPositions();
    this.persistFurniture();
  }

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
        snap.color !== agent.color ||
        snap.spriteSheet !== (agent.spriteSheet ?? "")
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
          spriteSheet: agent.spriteSheet ?? "",
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
    const { cols, rows } = this;
    const W = this.scale.gameSize.width;
    const H = this.scale.gameSize.height;

    // Custom background from asset pack — fall back to procedural on failure
    if (this.cachedBackground) {
      try {
        const bgCanvas = this.cachedBackground;
        if (!bgCanvas.width || !bgCanvas.height) throw new Error("empty background image");
        const texKey = "_custom_bg";
        if (this.textures.exists(texKey)) this.textures.remove(texKey);
        this.textures.addImage(
          texKey,
          bgCanvas as unknown as HTMLImageElement,
        );
        const officeW = cols * TILE;
        const officeH = rows * TILE;

        if (this.backgroundMode === "tile") {
          // Tile the image across the office area
          const imgW = bgCanvas.width;
          const imgH = bgCanvas.height;
          for (let y = 0; y < officeH; y += imgH) {
            for (let x = 0; x < officeW; x += imgW) {
              const s = this.add.sprite(x, y, texKey);
              s.setOrigin(0, 0);
              s.setDepth(0);
              this.bgObjects.push(s);
            }
          }
        } else {
          // "cover" (default) or "stretch" — scale to fill the office
          const bg = this.add.sprite(0, 0, texKey);
          bg.setOrigin(0, 0);
          bg.setDepth(0);
          if (this.backgroundMode === "stretch") {
            bg.setDisplaySize(officeW, officeH);
          } else {
            // Cover: scale to fill while maintaining aspect ratio
            const scaleX = officeW / bgCanvas.width;
            const scaleY = officeH / bgCanvas.height;
            const scale = Math.max(scaleX, scaleY);
            bg.setScale(scale);
          }
          this.bgObjects.push(bg);
        }

        // Dead zone fill for area outside the office grid
        const deadZone = this.add.graphics();
        deadZone.setDepth(0);
        deadZone.fillStyle(0x1a1a2a, 1);
        if (W > officeW) deadZone.fillRect(officeW, 0, W - officeW, H);
        if (H > officeH) deadZone.fillRect(0, officeH, W, H - officeH);
        this.bgObjects.push(deadZone);
        return;
      } catch (err) {
        console.warn("[OfficeScene] Custom background failed, falling back to procedural:", err);
        // Clear the broken background so we don't keep failing on rebuilds
        this.cachedBackground = null;
        // Fall through to procedural background below
      }
    }

    // Procedural office background
    const g = this.add.graphics();
    this.officeGraphics = g;

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

    // Restore user-added furniture from saved layout (both custom pack and builtin additions)
    if (this.savedLayout) {
      for (const item of this.savedLayout) {
        // Skip items that were already created by the default layout
        if (this.furnitureContainers.has(item.id)) continue;

        // Resolve the cache key — handles both "packId:key" and legacy bare keys
        const resolvedKey = item.custom && item.customKey
          ? this.resolveFurnitureKey(item.customKey, item.packId)
          : undefined;

        if (item.custom && resolvedKey) {
          // Custom pack furniture
          const config = this.furnitureConfigs.get(resolvedKey);
          this.createFurnitureContainer(item.id, item.type, item.x, item.y, {
            custom: true,
            customKey: resolvedKey,
            packId: item.packId ?? this.packIdFromKey(resolvedKey),
            isDesk: item.isDesk ?? config?.desk ?? false,
            rotation: item.rotation,
          });
        } else if (item.id.startsWith("added-")) {
          // User-added furniture (builtin or custom pack)
          // Skip custom pack items whose pack is not loaded
          if (item.custom && item.customKey && !resolvedKey) {
            continue;
          }
          this.createFurnitureContainer(item.id, item.type, item.x, item.y, {
            custom: item.custom,
            customKey: resolvedKey ?? item.customKey,
            packId: item.packId ?? (resolvedKey ? this.packIdFromKey(resolvedKey) : undefined),
            isDesk: item.isDesk,
            rotation: item.rotation,
          });
        }
      }
    }

    // Build desk chair positions from actual furniture locations
    // (which may have been overridden by saved layout)
    this.rebuildDeskPositions();
  }

  /** Resolve a furniture cache key. Tries the key as-is, then "packId:key",
   *  then scans all namespaced entries for a bare-key suffix match. */
  private resolveFurnitureKey(customKey: string, packId?: string): string | undefined {
    // Exact match (already namespaced, or bare key with backward-compat entry)
    if (this.cachedFurniture.has(customKey)) return customKey;
    // Try "packId:key"
    if (packId) {
      const ns = `${packId}:${customKey}`;
      if (this.cachedFurniture.has(ns)) return ns;
    }
    // Scan for any pack that has this bare key
    for (const k of this.cachedFurniture.keys()) {
      const colonIdx = k.indexOf(":");
      if (colonIdx >= 0 && k.slice(colonIdx + 1) === customKey) return k;
    }
    return undefined;
  }

  /** Extract the packId portion from a namespaced key ("packId:itemKey"). */
  private packIdFromKey(nsKey: string): string | undefined {
    const idx = nsKey.indexOf(":");
    return idx >= 0 ? nsKey.slice(0, idx) : undefined;
  }

  private createFurnitureContainer(
    id: string,
    type: FurnitureItem["type"],
    tileX: number,
    tileY: number,
    opts?: { custom?: boolean; customKey?: string; packId?: string; isDesk?: boolean; rotation?: number },
  ) {
    // Skip furniture the user has deleted
    if (this.removedFurnitureIds.has(id)) return;

    // Use saved position if available
    const saved = this.savedLayout?.find((f) => f.id === id);
    if (saved) {
      tileX = saved.x;
      tileY = saved.y;
    }
    const rotation = saved?.rotation ?? opts?.rotation ?? 0;

    const container = this.add.container(tileX * TILE, tileY * TILE);
    container.setDepth(5);
    container.setData("furnitureId", id);
    container.setData("furnitureType", type);

    // Custom furniture from asset pack — render PNG, fall back to builtin on failure
    const customCanvas = opts?.customKey
      ? this.cachedFurniture.get(opts.customKey)
      : undefined;

    if (customCanvas) {
      try {
        if (!customCanvas.width || !customCanvas.height) throw new Error("empty furniture image");
        const texKey = `furniture_${id}`;
        if (this.textures.exists(texKey)) this.textures.remove(texKey);
        this.textures.addImage(
          texKey,
          customCanvas as unknown as HTMLImageElement,
        );
        const config = this.furnitureConfigs.get(opts!.customKey!);
        // Determine tile footprint:
        // - If manifest specifies tiles, use those
        // - If image is already at tile scale (dimensions >= TILE), divide by TILE
        // - Otherwise, infer from aspect ratio: fit into 1-2 tiles
        let tw: number, th: number;
        if (config?.tilesWide != null && config?.tilesTall != null) {
          tw = config.tilesWide;
          th = config.tilesTall;
        } else if (customCanvas.width >= TILE * 1.5 || customCanvas.height >= TILE * 1.5) {
          // Large image — already at tile scale
          tw = Math.max(1, Math.round(customCanvas.width / TILE));
          th = Math.max(1, Math.round(customCanvas.height / TILE));
        } else {
          // Small pixel art — scale up based on aspect ratio
          const ratio = customCanvas.width / customCanvas.height;
          if (ratio > 1.8) {
            tw = 2; th = 1; // wide
          } else if (ratio < 0.55) {
            tw = 1; th = 2; // tall
          } else if (ratio > 1.2) {
            tw = 2; th = 1; // somewhat wide
          } else if (ratio < 0.8) {
            tw = 1; th = 2; // somewhat tall
          } else if (customCanvas.width > 50 || customCanvas.height > 50) {
            tw = 2; th = 2; // biggish square
          } else {
            tw = 1; th = 1; // small square
          }
        }
        const sprite = this.add.sprite(0, 0, texKey);
        sprite.setOrigin(0, 0);
        sprite.setDisplaySize(tw * TILE, th * TILE);
        sprite.setAngle(rotation);
        // Adjust origin for rotation
        if (rotation === 90) {
          sprite.setOrigin(0, 1);
        } else if (rotation === 180) {
          sprite.setOrigin(1, 1);
        } else if (rotation === 270) {
          sprite.setOrigin(1, 0);
        }
        container.add(sprite);

        const effW = rotation === 90 || rotation === 270 ? th : tw;
        const effH = rotation === 90 || rotation === 270 ? tw : th;
        const hitW = effW * TILE;
        const hitH = effH * TILE;
        container.setSize(hitW, hitH);
        container.setInteractive({ cursor: "pointer" });

        this.addFurnitureInteractions(container, id, hitW);

        this.furnitureContainers.set(id, container);
        this.furnitureItems.push({
          id,
          type,
          x: tileX,
          y: tileY,
          rotation,
          custom: true,
          customKey: opts?.customKey,
          packId: opts?.packId,
          isDesk: opts?.isDesk,
        });
        return;
      } catch (err) {
        console.warn(`[furniture] Custom furniture ${id} failed:`, err);
        // Remove broken entry so it doesn't keep failing
        if (opts?.customKey) this.cachedFurniture.delete(opts.customKey);
        // Only fall through if there's a matching builtin drawing; otherwise remove
        if (!OfficeScene.BUILTIN_FURNITURE.some((b) => b.type === type)) {
          container.destroy();
          return;
        }
      }
    }

    // Builtin furniture — procedural drawing
    try {
      const g = this.add.graphics();

      drawBuiltinFurniture(type, g);

      // Determine base tile size
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
      const baseTW = wideTypes.has(type) ? 2 : 1;
      const baseTH = tallTypes.has(type) ? 2 : 1;
      const baseW = baseTW * TILE;
      const baseH = baseTH * TILE;

      // Snapshot the procedural graphics to a texture so rotation works properly
      const texKey = `builtin_${id}_${rotation}`;
      if (this.textures.exists(texKey)) this.textures.remove(texKey);
      const rt = this.add.renderTexture(0, 0, baseW, baseH);
      rt.draw(g, 0, 0);
      rt.saveTexture(texKey);
      rt.destroy();
      g.destroy();

      const sprite = this.add.sprite(0, 0, texKey);
      sprite.setOrigin(0, 0);
      if (rotation) {
        sprite.setAngle(rotation);
        if (rotation === 90) sprite.setOrigin(0, 1);
        else if (rotation === 180) sprite.setOrigin(1, 1);
        else if (rotation === 270) sprite.setOrigin(1, 0);
      }
      container.add(sprite);

      // Effective hit area accounts for rotation swapping width/height
      const effTW = rotation === 90 || rotation === 270 ? baseTH : baseTW;
      const effTH = rotation === 90 || rotation === 270 ? baseTW : baseTH;
      const hitW = effTW * TILE;
      const hitH = effTH * TILE;
      container.setSize(hitW, hitH);
      container.setInteractive({ cursor: "pointer" });

      this.addFurnitureInteractions(container, id, hitW);

      this.furnitureContainers.set(id, container);
      this.furnitureItems.push({
        id,
        type,
        x: tileX,
        y: tileY,
        rotation,
        custom: opts?.custom,
        customKey: opts?.customKey,
        packId: opts?.packId,
        isDesk: opts?.isDesk ?? (type === "desk"),
      });
    } catch (err) {
      // Last resort — destroy the empty container so it doesn't linger
      console.warn(`[furniture] Builtin furniture ${id} (${type}) failed:`, err);
      container.destroy();
    }
  }

  /** Persist the current furniture layout including tombstones for removed defaults. */
  private persistFurniture() {
    if (!this.onFurnitureMove) return;
    const tombstones = [...this.removedFurnitureIds].map((rid) => ({
      id: rid,
      type: "removed" as string,
      x: 0,
      y: 0,
      removed: true,
    }));
    this.onFurnitureMove([...this.furnitureItems, ...tombstones] as FurnitureItem[]);
  }

  // ── Furniture edit mode state ──
  private editingFurnitureId: string | null = null;
  private editOverlay: Phaser.GameObjects.Container | null = null;
  private longPressTimer?: ReturnType<typeof setTimeout>;

  /** Dismiss the current furniture edit overlay. */
  private dismissFurnitureEdit() {
    this.stopFurnitureDrag();
    for (const obj of this.editOverlayObjects) obj.destroy();
    this.editOverlayObjects = [];
    this.editOverlay = null;
    this.editingFurnitureId = null;
  }

  /** All scene objects belonging to the current edit overlay. */
  private editOverlayObjects: Phaser.GameObjects.GameObject[] = [];

  /** Manual furniture drag state */
  private furnitureDragTarget: Phaser.GameObjects.Container | null = null;
  private furnitureDragOffset = { x: 0, y: 0 };
  private furnitureDragMoveHandler: ((p: Phaser.Input.Pointer) => void) | null = null;
  private furnitureDragUpHandler: ((p: Phaser.Input.Pointer) => void) | null = null;

  /** Start a manual drag on a furniture container. */
  private startFurnitureDrag(
    container: Phaser.GameObjects.Container,
    pointer: Phaser.Input.Pointer,
  ) {
    this.stopFurnitureDrag();
    this.furnitureDragTarget = container;
    this.furnitureDragOffset.x = container.x - pointer.worldX;
    this.furnitureDragOffset.y = container.y - pointer.worldY;
    this.isDragging = true;

    container.setDepth(50);
    this.tweens.add({
      targets: container,
      scaleX: 1.15,
      scaleY: 1.15,
      duration: 150,
      ease: "Back.easeOut",
    });
    this.showGridOverlay();

    this.dragShadow = this.add.graphics();
    this.dragShadow.setDepth(49);
    this.dragShadow.fillStyle(0x000000, 0.2);
    this.dragShadow.fillCircle(0, 0, 22);
    this.dragShadow.setPosition(container.x + 3, container.y + 3);

    this.furnitureDragMoveHandler = (p: Phaser.Input.Pointer) => {
      if (!this.furnitureDragTarget) return;
      const nx = p.worldX + this.furnitureDragOffset.x;
      const ny = p.worldY + this.furnitureDragOffset.y;
      this.furnitureDragTarget.x = nx;
      this.furnitureDragTarget.y = ny;
      this.updateGridOverlay(nx, ny);
      if (this.dragShadow) this.dragShadow.setPosition(nx + 3, ny + 3);
      if (this.editingFurnitureId) {
        this.repositionEditOverlay(nx, ny);
      }
    };

    this.furnitureDragUpHandler = (_p: Phaser.Input.Pointer) => {
      this.finishFurnitureDrag();
    };

    this.input.on("pointermove", this.furnitureDragMoveHandler);
    this.input.on("pointerup", this.furnitureDragUpHandler);
  }

  /** Finish manual drag — snap to grid, update position, persist. */
  private finishFurnitureDrag() {
    const container = this.furnitureDragTarget;
    if (!container) return;

    this.hideGridOverlay();
    if (this.dragShadow) {
      this.dragShadow.destroy();
      this.dragShadow = undefined;
    }

    const snapped = this.snapToGrid(container.x, container.y);
    this.tweens.add({
      targets: container,
      x: snapped.px,
      y: snapped.py,
      scaleX: 1,
      scaleY: 1,
      duration: 250,
      ease: "Bounce.easeOut",
    });

    const fid = container.getData("furnitureId") as string | undefined;
    if (fid) {
      const item = this.furnitureItems.find((f) => f.id === fid);
      if (item) {
        item.x = snapped.tileX;
        item.y = snapped.tileY;
        if (item.type === "desk" || item.isDesk) {
          this.rebuildDeskPositions();
          this.assignDesks();
        }
        this.persistFurniture();
      }
    }

    container.setDepth(5);
    if (this.editingFurnitureId) {
      this.repositionEditOverlay(snapped.px, snapped.py);
    }

    this.stopFurnitureDrag();
  }

  /** Clean up drag listeners. */
  private stopFurnitureDrag() {
    if (this.furnitureDragMoveHandler) {
      this.input.off("pointermove", this.furnitureDragMoveHandler);
      this.furnitureDragMoveHandler = null;
    }
    if (this.furnitureDragUpHandler) {
      this.input.off("pointerup", this.furnitureDragUpHandler);
      this.furnitureDragUpHandler = null;
    }
    this.furnitureDragTarget = null;
    this.isDragging = false;
  }

  /** Create a button texture via offscreen canvas. */
  private createButtonTexture(
    key: string,
    bgColor: string,
    label: string,
    fontSize = "15px",
  ): string {
    const canvas = document.createElement("canvas");
    canvas.width = 22;
    canvas.height = 22;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = bgColor;
    ctx.beginPath();
    ctx.roundRect(0, 0, 22, 22, 5);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${fontSize} system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, 11, 12);
    if (this.textures.exists(key)) this.textures.remove(key);
    this.textures.addImage(key, canvas as unknown as HTMLImageElement);
    return key;
  }

  /** Show the edit overlay (border + rotate + delete) for a furniture item. */
  private showFurnitureEdit(id: string) {
    this.dismissFurnitureEdit();
    const container = this.furnitureContainers.get(id);
    const item = this.furnitureItems.find((f) => f.id === id);
    if (!container || !item) return;

    this.editingFurnitureId = id;
    const cx = container.x;
    const cy = container.y;
    const w = container.width;
    const h = container.height;
    const objs = this.editOverlayObjects;

    // Dashed border
    const border = this.add.graphics();
    border.setDepth(60);
    border.setPosition(cx, cy);
    border.lineStyle(2, 0x6366f1, 0.8);
    const dashLen = 4;
    const gap = 3;
    for (const [x1, y1, x2, y2] of [
      [0, 0, w, 0], [w, 0, w, h], [w, h, 0, h], [0, h, 0, 0],
    ] as [number, number, number, number][]) {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.sqrt(dx * dx + dy * dy);
      const ux = dx / len;
      const uy = dy / len;
      let d = 0;
      let drawing = true;
      while (d < len) {
        const seg = Math.min(drawing ? dashLen : gap, len - d);
        if (drawing) {
          border.beginPath();
          border.moveTo(x1 + ux * d, y1 + uy * d);
          border.lineTo(x1 + ux * (d + seg), y1 + uy * (d + seg));
          border.strokePath();
        }
        d += seg;
        drawing = !drawing;
      }
    }
    // Semi-transparent fill
    border.fillStyle(0x000000, 0.15);
    border.fillRect(0, 0, w, h);
    objs.push(border);

    // Buttons in world space
    const btnY = cy - 14;
    const btnSpacing = 26;
    const btnCenterX = cx + w / 2;

    // Rotate button
    const rotKey = this.createButtonTexture(`_rot_${id}`, "#4f46e5", "↻", "16px");
    const rotateBtn = this.add.sprite(btnCenterX - btnSpacing / 2, btnY, rotKey);
    rotateBtn.setDepth(61);
    rotateBtn.setOrigin(0.5, 0.5);
    rotateBtn.setInteractive({ cursor: "pointer" });
    rotateBtn.on("pointerdown", () => {
      if (!item) return;
      item.rotation = ((item.rotation ?? 0) + 90) % 360;
      const sprite = container.list.find(
        (c): c is Phaser.GameObjects.Sprite => c instanceof Phaser.GameObjects.Sprite,
      );
      if (sprite) {
        sprite.setAngle(item.rotation);
        if (item.rotation === 90) sprite.setOrigin(0, 1);
        else if (item.rotation === 180) sprite.setOrigin(1, 1);
        else if (item.rotation === 270) sprite.setOrigin(1, 0);
        else sprite.setOrigin(0, 0);
      }
      // Swap container hit area to match rotated dimensions
      const oldW = container.width;
      const oldH = container.height;
      container.setSize(oldH, oldW);
      this.persistFurniture();
      // Refresh the overlay to match new dimensions
      this.dismissFurnitureEdit();
      this.showFurnitureEdit(id);
    });
    objs.push(rotateBtn);

    // Delete button
    const delKey = this.createButtonTexture(`_del_${id}`, "#dc2626", "✕");
    const deleteBtn = this.add.sprite(btnCenterX + btnSpacing / 2, btnY, delKey);
    deleteBtn.setDepth(61);
    deleteBtn.setOrigin(0.5, 0.5);
    deleteBtn.setInteractive({ cursor: "pointer" });
    deleteBtn.on("pointerdown", () => {
      this.dismissFurnitureEdit();
      this.removeFurniture(id);
    });
    objs.push(deleteBtn);

    // Use a dummy container ref so drag tracking can reposition the overlay
    const overlayRef = this.add.container(0, 0);
    overlayRef.setVisible(false);
    objs.push(overlayRef);
    this.editOverlay = overlayRef;
  }

  /** Reposition all edit overlay objects to follow a dragged furniture item. */
  private repositionEditOverlay(cx: number, cy: number) {
    const objs = this.editOverlayObjects;
    if (objs.length < 3) return;
    const container = this.furnitureContainers.get(this.editingFurnitureId!);
    if (!container) return;
    const w = container.width;
    const h = container.height;
    // border
    (objs[0] as Phaser.GameObjects.Graphics).setPosition(cx, cy);
    // rotate btn
    const btnY = cy - 14;
    const btnCenterX = cx + w / 2;
    (objs[1] as Phaser.GameObjects.Sprite).setPosition(btnCenterX - 13, btnY);
    // delete btn
    (objs[2] as Phaser.GameObjects.Sprite).setPosition(btnCenterX + 13, btnY);
  }

  /** Add long-press-to-edit and hover cursor to a furniture container. */
  private addFurnitureInteractions(
    container: Phaser.GameObjects.Container,
    id: string,
    _hitW: number,
  ) {
    // Long press (250ms) opens edit mode
    container.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (pointer.rightButtonDown()) return;
      if (this.longPressTimer) clearTimeout(this.longPressTimer);
      this.longPressTimer = setTimeout(() => {
        if (!this.isDragging && pointer.isDown) {
          this.showFurnitureEdit(id);
          // Start manual drag immediately — pointer is still held
          this.startFurnitureDrag(container, pointer);
        }
      }, 250);
    });

    container.on("pointerup", () => {
      if (this.longPressTimer) {
        clearTimeout(this.longPressTimer);
        this.longPressTimer = undefined;
      }
    });

    container.on("pointerout", () => {
      if (this.longPressTimer) {
        clearTimeout(this.longPressTimer);
        this.longPressTimer = undefined;
      }
    });
  }

  private rebuildDeskPositions() {
    this.deskPositions = [];
    for (const item of this.furnitureItems) {
      if (item.type === "desk" || item.isDesk) {
        this.deskPositions.push({ x: item.x + 1, y: item.y + 1 });
      }
    }
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

  /**
   * Resolve a cached sprite sheet canvas for an agent.
   * Priority: per-agent override → exact role match → hash-based rotation.
   */
  /** Validate a cached sheet canvas — remove and return null if broken. */
  private validateSheet(key: string): HTMLCanvasElement | null {
    const canvas = this.cachedSheets.get(key);
    if (!canvas || !canvas.width || !canvas.height) {
      this.cachedSheets.delete(key);
      return null;
    }
    return canvas;
  }

  private resolveSheetForAgent(agent: Agent): HTMLCanvasElement | null {
    if (!this.activePack || this.cachedSheets.size === 0) return null;

    // Per-agent override (set in AgentEditor)
    if (agent.spriteSheet) {
      const sheet = this.validateSheet(agent.spriteSheet);
      if (sheet) return sheet;
      // Override not available — fall through to other sources
    }

    // Exact role match
    const role = agent.role.toLowerCase();
    if (this.cachedSheets.has(role)) {
      const sheet = this.validateSheet(role);
      if (sheet) return sheet;
    }

    // Distribute sheets across agents using a stable hash of the agent ID
    if (this.cachedSheets.size === 0) return null; // all sheets may have been pruned
    const sheetKeys = [...this.cachedSheets.keys()];
    let hash = 0;
    for (let i = 0; i < agent.id.length; i++) {
      hash = ((hash << 5) - hash + agent.id.charCodeAt(i)) | 0;
    }
    const idx = Math.abs(hash) % sheetKeys.length;
    return this.validateSheet(sheetKeys[idx]);
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

    // Generate or load sprite sheet
    let animKeys: Record<AnimState, string>;
    const sheetCanvas = this.resolveSheetForAgent(agent);
    if (sheetCanvas) {
      try {
        const employees = this.activePack?.manifest.categories.employees;
        if (!employees) throw new Error("no employees config");
        animKeys = registerAgentFromSheet(this, agent.id, sheetCanvas, {
          frameSize: employees.frameSize,
          frameWidth: employees.frameWidth,
          frameHeight: employees.frameHeight,
          framesPerState: employees.framesPerState,
          rows: employees.rows,
          states: employees.states,
          frameRates: employees.frameRates,
        });
      } catch (err) {
        console.warn(`[sprites] Failed to load sheet for ${agent.id}, falling back to procedural:`, err);
        // Remove the broken sheet from cache so we don't keep failing
        for (const [k, v] of this.cachedSheets) {
          if (v === sheetCanvas) { this.cachedSheets.delete(k); break; }
        }
        const shirtColor = parseInt(agent.color.replace("#", ""), 16);
        const palette = buildPalette(shirtColor, this.agentIndex++);
        animKeys = registerAgentTextures(this, agent.id, palette);
      }
    } else {
      const shirtColor = parseInt(agent.color.replace("#", ""), 16);
      const palette = buildPalette(shirtColor, this.agentIndex++);
      animKeys = registerAgentTextures(this, agent.id, palette);
    }
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
      spriteSheet: agent.spriteSheet ?? "",
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
      spriteSheet: agent.spriteSheet ?? "",
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
