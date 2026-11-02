/**
 * North Carolina FRIS Flood Zones, independent ArcGIS MapServer sublayers.
 *
 * Source: NC Emergency Management / FRIS effective FIRM data.
 * https://spartagis.ncem.org/arcgis/rest/services/Public/FRIS_FloodZones/MapServer
 *
 * IMPORTANT: The source is a fused/cached MapServer. Reading its normal /tile
 * endpoint would show ALL THREE layers for every switch. Instead we use the
 * /export operation with layers=show:<id> for each transparent imagery layer.
 * This preserves the source's authoritative drawing symbols/zone categories.
 *
 * These overlays are imagery draped on the Cesium globe. Google's 3D Tiles
 * hide that globe; turning an FRIS layer on switches to Esri imagery first.
 */
import * as Cesium from 'cesium';

export const FRIS_MAPSERVER =
  'https://spartagis.ncem.org/arcgis/rest/services/Public/FRIS_FloodZones/MapServer';

export const FRIS_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'nc-fris-stream-centerlines',
    serviceLayerId: 0,
    name: 'NC FRIS - Stream Centerlines',
    icon: '~',
    alpha: 1,
  }),
  Object.freeze({
    id: 'nc-fris-flood-hazard-lines',
    serviceLayerId: 1,
    name: 'NC FRIS - Flood Hazard Lines',
    icon: '/',
    alpha: 1,
  }),
  Object.freeze({
    id: 'nc-fris-flood-hazard-areas',
    serviceLayerId: 2,
    name: 'NC FRIS - Flood Hazard Areas',
    icon: '#',
    alpha: 0.62,
  }),
]);

// Only tracking currently installed FRIS imagery, never the basemap imagery.
const installedByViewer = new WeakMap();
const mapSwitchByController = new WeakMap();

function installed(viewer) {
  let values = installedByViewer.get(viewer);
  if (!values) {
    values = new Map();
    installedByViewer.set(viewer, values);
  }
  return values;
}

function reorder(viewer) {
  // Flood polygons below lines, regardless of the order toggles are clicked.
  const values = installed(viewer);
  for (const serviceLayerId of [2, 0, 1]) {
    const layer = values.get(serviceLayerId);
    if (layer && viewer.imageryLayers.contains(layer)) {
      viewer.imageryLayers.raiseToTop(layer);
    }
  }
  viewer.scene.requestRender();
}

async function switchToGlobeIfNeeded(viewer, controller) {
  if (viewer.scene.globe.show) return;
  if (!controller?.setStack) {
    throw new Error('Choose an imagery/globe map stack to display FRIS overlays.');
  }
  let request = mapSwitchByController.get(controller);
  if (!request) {
    request = Promise.resolve(controller.setStack('esri-imagery'));
    mapSwitchByController.set(controller, request);
    void request.finally(() => {
      if (mapSwitchByController.get(controller) === request) {
        mapSwitchByController.delete(controller);
      }
    }).catch(() => {});
  }
  await request;
  if (!viewer.scene.globe.show) {
    throw new Error('FRIS overlay requires a globe imagery map stack.');
  }
}

function createExportUrl(serviceLayerId) {
  const bbox =
    '{westProjected},{southProjected},{eastProjected},{northProjected}';
  const params = [
    `bbox=${bbox}`,
    'bboxSR=3857',
    'imageSR=3857',
    'size=256%2C256',
    'dpi=96',
    'format=png32',
    'transparent=true',
    `layers=show%3A${serviceLayerId}`,
    'f=image',
  ];
  return `${FRIS_MAPSERVER}/export?${params.join('&')}`;
}

/** Return an independent layer implementing God's Eye View LayerLifecycle. */
export function createFrisFloodZoneLayer(definition) {
  const { id, serviceLayerId, name, icon, alpha } = definition;
  if (![0, 1, 2].includes(serviceLayerId)) {
    throw new RangeError(`Unknown FRIS sublayer: ${serviceLayerId}`);
  }
  let viewer = null;
  let mapStackController = null;
  let imageryLayer = null;
  let removeErrorListener = null;
  let enabled = false;
  let lastUpdate = null;
  let lastError = null;
  let rowListener = null;

  const notify = () => rowListener?.();
  const removeImagery = () => {
    removeErrorListener?.();
    removeErrorListener = null;
    if (imageryLayer && viewer) {
      const values = installed(viewer);
      if (values.get(serviceLayerId) === imageryLayer) {
        values.delete(serviceLayerId);
      }
      if (viewer.imageryLayers.contains(imageryLayer)) {
        viewer.imageryLayers.remove(imageryLayer, true);
      }
    }
    imageryLayer = null;
    viewer?.scene?.requestRender?.();
  };

  return {
    id,
    name,
    icon,
    source: 'NC Emergency Management / FRIS',
    showInTogglePanel: true,
    // Raster layers do not need data polling; this is a cheap manager heartbeat.
    updateInterval: 300_000,

    attachMapStackController(controller) {
      mapStackController = controller;
    },

    init(sceneViewer) {
      if (viewer && viewer !== sceneViewer) {
        throw new Error(`${id} was initialized by another viewer`);
      }
      viewer = sceneViewer;
      lastError = null;
      return true;
    },

    async enable(_sceneViewer, { signal } = {}) {
      if (!viewer) throw new Error(`${id} was not initialized`);
      if (signal?.aborted) return false;
      await switchToGlobeIfNeeded(viewer, mapStackController);
      if (signal?.aborted) return false;
      if (!imageryLayer) {
        // A UrlTemplate provider is intentional: ArcGIS's fused cached /tile
        // endpoint cannot isolate 0/1/2. Each exported tile is on-demand.
        const provider = new Cesium.UrlTemplateImageryProvider({
          url: createExportUrl(serviceLayerId),
          tilingScheme: new Cesium.WebMercatorTilingScheme(),
          rectangle: Cesium.Rectangle.fromDegrees(-85, 33.3, -75, 37),
          minimumLevel: 0,
          maximumLevel: 19,
          tileWidth: 256,
          tileHeight: 256,
          credit: new Cesium.Credit('NC Emergency Management - FRIS Flood Zones'),
        });
        removeErrorListener = provider.errorEvent.addEventListener((error) => {
          if (!enabled) return;
          lastError = `FRIS tile request failed: ${error?.message || 'service unavailable'}`;
          notify();
          console.warn(`[FRIS] ${name}:`, error);
        });
        try {
          imageryLayer = viewer.imageryLayers.addImageryProvider(provider);
        } catch (error) {
          removeErrorListener?.();
          removeErrorListener = null;
          throw error;
        }
        imageryLayer.alpha = alpha;
        installed(viewer).set(serviceLayerId, imageryLayer);
      }
      enabled = true;
      imageryLayer.show = true;
      reorder(viewer);
      lastUpdate = Date.now();
      lastError = null;
      notify();
      return true;
    },

    disable() {
      enabled = false;
      removeImagery(); // Release tile textures/network work while OFF.
      lastError = null;
      notify();
      return true;
    },

    update() {
      // The ArcGIS exporter renders the current view through Cesium's tile
      // requests; there is no statewide feature download or manual refresh.
      return true;
    },

    getRowControls() {
      return {
        info: viewer && !viewer.scene.globe.show
          ? 'Switch Map Stack to Esri imagery or OSM: Google 3D hides raster overlays.'
          : serviceLayerId === 1
            ? 'Zoom in closely: flood hazard lines appear around 1:20,000 or closer.'
            : 'Zoom to North Carolina: FRIS draws at 1:150,000 or closer.',
      };
    },

    setRowControlsListener(listener) {
      rowListener = typeof listener === 'function' ? listener : null;
    },

    getStats() {
      return {
        count: 0, // This is imagery; do not misreport image tiles as features.
        countLabel: enabled ? 'MAP' : '',
        lastUpdate,
        error: lastError,
      };
    },

    destroy() {
      enabled = false;
      removeImagery();
      viewer = null;
      mapStackController = null;
      lastUpdate = null;
      lastError = null;
      rowListener = null;
    },
  };
}

export function createFrisFloodZoneLayers() {
  return FRIS_DEFINITIONS.map((definition) => createFrisFloodZoneLayer(definition));
}
