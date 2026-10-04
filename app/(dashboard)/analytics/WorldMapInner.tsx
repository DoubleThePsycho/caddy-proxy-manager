"use client";

/**
 * The countries map of the analytics page (the "Map" view of the countries
 * panel): each country shaded by its share of the requests, with a popup
 * of its requests and mitigated requests. Colours come from the theme's
 * tokens, read when the theme changes.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import MapGL, { Layer, Popup, Source, type MapLayerMouseEvent } from "react-map-gl/maplibre";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import { setWorkerUrl, type ExpressionSpecification, type FillLayerSpecification, type LineLayerSpecification } from "maplibre-gl";
import { useTheme } from "next-themes";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCount } from "@/components/ui/chart-format";
import { countryName } from "./present";
import "maplibre-gl/dist/maplibre-gl.css";

// maplibre-gl v6 loads its tile worker from a separate file resolved at runtime
// from `import.meta.url`. Under Turbopack that lookup does not survive bundling,
// so the worker never starts and the map renders as an empty ocean. The worker
// is staged under public/ at build time (scripts/copy-maplibre-worker.mjs) and
// pointed at explicitly here. Requires `worker-src 'self'` in the CSP (proxy.ts):
// the worker is a same-origin URL now, not the blob: URL v5 used.
if (typeof window !== "undefined") {
  setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');
}

const A2N: Record<string, string> = {
  AF:'4',AL:'8',DZ:'12',AD:'20',AO:'24',AG:'28',AR:'32',AM:'51',
  AU:'36',AT:'40',AZ:'31',BS:'44',BH:'48',BD:'50',BB:'52',BY:'112',
  BE:'56',BZ:'84',BJ:'204',BT:'64',BO:'68',BA:'70',BW:'72',BR:'76',
  BN:'96',BG:'100',BF:'854',BI:'108',CV:'132',KH:'116',CM:'120',
  CA:'124',CF:'140',TD:'148',CL:'152',CN:'156',CO:'170',KM:'174',
  CG:'178',CD:'180',CR:'188',CI:'384',HR:'191',CU:'192',CY:'196',
  CZ:'203',DK:'208',DJ:'262',DM:'212',DO:'214',EC:'218',EG:'818',
  SV:'222',GQ:'226',ER:'232',EE:'233',SZ:'748',ET:'231',FJ:'242',
  FI:'246',FR:'250',GA:'266',GM:'270',GE:'268',DE:'276',GH:'288',
  GR:'300',GD:'308',GT:'320',GN:'324',GW:'624',GY:'328',HT:'332',
  HN:'340',HU:'348',IS:'352',IN:'356',ID:'360',IR:'364',IQ:'368',
  IE:'372',IL:'376',IT:'380',JM:'388',JP:'392',JO:'400',KZ:'398',
  KE:'404',KI:'296',KP:'408',KR:'410',KW:'414',KG:'417',LA:'418',
  LV:'428',LB:'422',LS:'426',LR:'430',LY:'434',LI:'438',LT:'440',
  LU:'442',MG:'450',MW:'454',MY:'458',MV:'462',ML:'466',MT:'470',
  MH:'584',MR:'478',MU:'480',MX:'484',FM:'583',MD:'498',MC:'492',
  MN:'496',ME:'499',MA:'504',MZ:'508',MM:'104',NA:'516',NR:'520',
  NP:'524',NL:'528',NZ:'554',NI:'558',NE:'562',NG:'566',NO:'578',
  OM:'512',PK:'586',PW:'585',PA:'591',PG:'598',PY:'600',PE:'604',
  PH:'608',PL:'616',PT:'620',QA:'634',RO:'642',RU:'643',RW:'646',
  KN:'659',LC:'662',VC:'670',WS:'882',SM:'674',ST:'678',SA:'682',
  SN:'686',RS:'688',SC:'690',SL:'694',SG:'702',SK:'703',SI:'705',
  SB:'90',SO:'706',ZA:'710',SS:'728',ES:'724',LK:'144',SD:'729',
  SR:'740',SE:'752',CH:'756',SY:'760',TW:'158',TJ:'762',TZ:'834',
  TH:'764',TL:'626',TG:'768',TO:'776',TT:'780',TN:'788',TR:'792',
  TM:'795',TV:'798',UG:'800',UA:'804',AE:'784',GB:'826',US:'840',
  UY:'858',UZ:'860',VU:'548',VE:'862',VN:'704',YE:'887',ZM:'894',
  ZW:'716',PS:'275',
};
const N2A: Record<string, string> = Object.fromEntries(Object.entries(A2N).map(([a, n]) => [n, a]));

// Unwrap polygon rings so consecutive vertices never jump more than 180° in longitude.
// This prevents MapLibre from drawing giant artifacts for countries crossing ±180° (Russia, Fiji, etc.).
// Coordinates outside [-180, 180] are intentional: MapLibre renders them via world-copy tiling.
function cutAntimeridian(fc: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection {
  function unwrapRing(ring: GeoJSON.Position[]): GeoJSON.Position[] {
    if (ring.length === 0) return ring;
    const out: GeoJSON.Position[] = [[ring[0][0], ring[0][1]]];
    for (let i = 1; i < ring.length; i++) {
      let lng = ring[i][0];
      const prev = out[i - 1][0];
      while (lng - prev > 180) lng -= 360;
      while (prev - lng > 180) lng += 360;
      out.push([lng, ring[i][1]]);
    }
    return out;
  }

  function fixGeometry(geom: GeoJSON.Geometry): GeoJSON.Geometry {
    if (geom.type === "Polygon") return { ...geom, coordinates: geom.coordinates.map(unwrapRing) };
    if (geom.type === "MultiPolygon") return { ...geom, coordinates: geom.coordinates.map((p) => p.map(unwrapRing)) };
    return geom;
  }

  return {
    ...fc,
    features: fc.features.map((f) => (f.geometry ? { ...f, geometry: fixGeometry(f.geometry) } : f)),
  };
}

type MapColors = { water: string; land: string; low: string; high: string; outline: string; selected: string };

/** Token colours as MapLibre needs them (it cannot read CSS variables). */
const FALLBACK_COLORS: MapColors = { water: "#15181E", land: "#262B35", low: "#A5C4FF", high: "#4D8EFF", outline: "#343B48", selected: "#A194FF" };

function readColors(): MapColors {
  if (typeof window === "undefined") return FALLBACK_COLORS;
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    water: read("--panel", FALLBACK_COLORS.water),
    land: read("--raise", FALLBACK_COLORS.land),
    low: read("--served2", FALLBACK_COLORS.low),
    high: read("--served", FALLBACK_COLORS.high),
    outline: read("--line2", FALLBACK_COLORS.outline),
    selected: read("--brand", FALLBACK_COLORS.selected),
  };
}

export interface CountryStats {
  countryCode: string;
  total: number;
  /** Mitigated requests. */
  blocked: number;
}

interface HoverInfo {
  longitude: number;
  latitude: number;
  alpha2: string | null;
  total: number;
  blocked: number;
}

export default function WorldMapInner({ data }: { data: CountryStats[] }) {
  const [baseGeojson, setBaseGeojson] = useState<GeoJSON.FeatureCollection | null>(null);
  const [hoverInfo, setHoverInfo] = useState<HoverInfo | null>(null);
  const { resolvedTheme } = useTheme();
  const [colors, setColors] = useState<MapColors>(FALLBACK_COLORS);

  useEffect(() => {
    setColors(readColors());
  }, [resolvedTheme]);

  const countMap = useMemo(() => new Map(data.map((d) => [d.countryCode, d.total])), [data]);
  const blockedMap = useMemo(() => new Map(data.map((d) => [d.countryCode, d.blocked])), [data]);
  const max = useMemo(() => data.reduce((m, d) => Math.max(m, d.total), 0), [data]);

  useEffect(() => {
    let active = true;
    fetch("/geo/countries-50m.json")
      .then((r) => r.json())
      .then((topo: Topology) => {
        const fc = feature(topo, topo.objects.countries as GeometryCollection) as GeoJSON.FeatureCollection;
        if (active) setBaseGeojson(cutAntimeridian(fc));
      })
      .catch(() => {
        if (active) setBaseGeojson({ type: "FeatureCollection", features: [] });
      });
    return () => {
      active = false;
    };
  }, []);

  const geojson = useMemo<GeoJSON.FeatureCollection | null>(() => {
    if (!baseGeojson) return null;
    const safeMax = Math.max(max, 1);
    return {
      ...baseGeojson,
      features: baseGeojson.features.map((f) => {
        const alpha2 = N2A[String(Number(f.id ?? 0))] ?? null;
        const total = alpha2 ? (countMap.get(alpha2) ?? 0) : 0;
        const blocked = alpha2 ? (blockedMap.get(alpha2) ?? 0) : 0;
        // Square root: small countries stay visible next to the busiest one.
        return { ...f, properties: { ...f.properties, alpha2, total, blocked, norm: Math.sqrt(total / safeMax) } };
      }),
    };
  }, [baseGeojson, countMap, blockedMap, max]);

  const mapStyle = useMemo(
    () => ({
      version: 8 as const,
      name: "blank",
      sources: {},
      layers: [{ id: "bg", type: "background" as const, paint: { "background-color": colors.water } }],
    }),
    [colors.water]
  );

  const fillLayer = useMemo<Omit<FillLayerSpecification, "source">>(
    () => ({
      id: "countries-fill",
      type: "fill",
      paint: {
        "fill-color": [
          "interpolate",
          ["linear"],
          ["coalesce", ["get", "norm"], 0],
          0,
          colors.land,
          0.001,
          colors.low,
          1,
          colors.high,
        ] as ExpressionSpecification,
        "fill-opacity": 1,
      },
    }),
    [colors.land, colors.low, colors.high]
  );

  const hoverLayer = useMemo<Omit<FillLayerSpecification, "source">>(
    () => ({ id: "countries-hover", type: "fill", paint: { "fill-color": colors.selected, "fill-opacity": 0.35 } }),
    [colors.selected]
  );

  const outlineLayer = useMemo<Omit<LineLayerSpecification, "source">>(
    () => ({ id: "countries-outline", type: "line", paint: { "line-color": colors.outline, "line-width": 0.6 } }),
    [colors.outline]
  );

  const onHover = useCallback((event: MapLayerMouseEvent) => {
    const f = event.features?.[0];
    if (!f) {
      setHoverInfo(null);
      return;
    }
    setHoverInfo({
      longitude: event.lngLat.lng,
      latitude: event.lngLat.lat,
      alpha2: (f.properties?.alpha2 as string | null) ?? null,
      total: (f.properties?.total as number) ?? 0,
      blocked: (f.properties?.blocked as number) ?? 0,
    });
  }, []);

  const hoverFilter = useMemo<ExpressionSpecification>(() => {
    const a2 = hoverInfo?.alpha2 ?? null;
    return a2 ? ["==", ["get", "alpha2"], a2] : ["boolean", false];
  }, [hoverInfo?.alpha2]);

  if (!geojson) return <Skeleton className="h-[300px] w-full rounded-lg" />;

  return (
    <div className="relative flex flex-col gap-1.5">
      {/* MapLibre's popup frame, in the theme's colours. */}
      <style>{`
        .wm-popup .maplibregl-popup-content {
          background: var(--panel);
          color: var(--foreground);
          border: 1px solid var(--line2);
          border-radius: 10px;
          padding: 10px 12px;
          box-shadow: var(--shadow-overlay);
          min-width: 160px;
        }
        .wm-popup .maplibregl-popup-tip { display: none; }
      `}</style>

      <div className="h-[300px] w-full overflow-hidden rounded-lg border border-line">
        <MapGL
          mapStyle={mapStyle}
          initialViewState={{ bounds: [[-168, -56], [168, 74]], fitBoundsOptions: { padding: 4 } }}
          minZoom={0.5}
          interactiveLayerIds={["countries-fill"]}
          onMouseMove={onHover}
          onMouseLeave={() => setHoverInfo(null)}
          style={{ width: "100%", height: "100%" }}
          attributionControl={false}
          dragRotate={false}
          pitchWithRotate={false}
          cursor={hoverInfo ? "crosshair" : "grab"}
        >
          <Source id="countries" type="geojson" data={geojson}>
            <Layer {...fillLayer} source="countries" />
            <Layer {...hoverLayer} source="countries" filter={hoverFilter} />
            <Layer {...outlineLayer} source="countries" />
          </Source>

          {hoverInfo && (
            <Popup
              longitude={hoverInfo.longitude}
              latitude={hoverInfo.latitude}
              offset={[0, -6] as [number, number]}
              closeButton={false}
              closeOnClick={false}
              anchor="bottom"
              className="wm-popup"
            >
              <div className="flex flex-col gap-1 text-[13px]">
                <div className="mb-1 flex items-center gap-2 font-semibold">
                  {hoverInfo.alpha2 && <span className="num rounded bg-raise px-1.5 text-[11px] leading-[18px] text-muted-foreground">{hoverInfo.alpha2}</span>}
                  <span>{hoverInfo.alpha2 ? countryName(hoverInfo.alpha2) : "Territory"}</span>
                </div>
                <div className="flex justify-between gap-5">
                  <span className="text-muted-foreground">Requests</span>
                  <span className="num font-semibold">{formatCount(hoverInfo.total)}</span>
                </div>
                {hoverInfo.blocked > 0 && (
                  <div className="flex justify-between gap-5">
                    <span className="text-muted-foreground">Mitigated</span>
                    <span className="num font-semibold text-waf-ink">{formatCount(hoverInfo.blocked)}</span>
                  </div>
                )}
                {hoverInfo.total === 0 && <div className="text-xs text-soft">No requests in this period</div>}
              </div>
            </Popup>
          )}
        </MapGL>
      </div>

      {max > 0 && (
        <div className="flex items-center gap-2 px-0.5" aria-hidden="true">
          <span className="text-xs text-soft">Fewer</span>
          <span className="h-[5px] flex-1 rounded-full" style={{ background: "linear-gradient(to right, var(--served2), var(--served))" }} />
          <span className="text-xs text-soft">More requests</span>
        </div>
      )}
    </div>
  );
}
