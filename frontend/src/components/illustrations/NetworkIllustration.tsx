import { Mic, MicOff, ShieldCheck, Video } from 'lucide-react'
import { ConnectMark } from '../brand/ConnectLogo'

// Participant nodes around the hub. Coordinates are in the 520×420 SVG viewBox.
const nodes = [
  { x: 92, y: 96, r: 22, label: 'AR', color: '#2878E5' },
  { x: 432, y: 82, r: 18, label: 'KD', color: '#20C4D8' },
  { x: 462, y: 268, r: 24, label: 'MI', color: '#7C3AED' },
  { x: 70, y: 300, r: 18, label: 'RM', color: '#0EA5A4' },
  { x: 268, y: 378, r: 16, label: 'PN', color: '#1769AA' },
  { x: 262, y: 34, r: 14, label: 'SK', color: '#2878E5' },
]
const HUB = { x: 260, y: 205 }

/** Animated "connected participants" illustration for the login brand panel. Pure SVG + CSS. */
export function NetworkIllustration() {
  return (
    <div className="relative mx-auto aspect-[520/420] w-full max-w-[520px] select-none" aria-hidden>
      <svg viewBox="0 0 520 420" className="absolute inset-0 size-full overflow-visible">
        <defs>
          <radialGradient id="ni-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0" stopColor="#20C4D8" stopOpacity="0.35" />
            <stop offset="1" stopColor="#20C4D8" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="ni-line" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#20C4D8" stopOpacity="0.9" />
            <stop offset="1" stopColor="#2878E5" stopOpacity="0.6" />
          </linearGradient>
        </defs>

        <circle cx={HUB.x} cy={HUB.y} r="150" fill="url(#ni-glow)" />
        {/* Orbits */}
        <g style={{ transformOrigin: `${HUB.x}px ${HUB.y}px` }} className="animate-spin-slow">
          <circle cx={HUB.x} cy={HUB.y} r="118" fill="none" stroke="#FFFFFF" strokeOpacity="0.12" strokeDasharray="2 7" />
          <circle cx={HUB.x + 118} cy={HUB.y} r="3" fill="#20C4D8" />
        </g>
        <circle cx={HUB.x} cy={HUB.y} r="176" fill="none" stroke="#FFFFFF" strokeOpacity="0.07" />

        {/* Connections with flowing data */}
        {nodes.map((n, i) => (
          <g key={n.label}>
            <line x1={HUB.x} y1={HUB.y} x2={n.x} y2={n.y} stroke="#FFFFFF" strokeOpacity="0.1" strokeWidth="1.5" />
            <line
              x1={HUB.x}
              y1={HUB.y}
              x2={n.x}
              y2={n.y}
              stroke="url(#ni-line)"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeDasharray="4 16"
              className="animate-dash"
              style={{ animationDelay: `${i * -0.5}s` }}
            />
          </g>
        ))}

        {/* Participant nodes */}
        {nodes.map((n, i) => (
          <g key={`n-${n.label}`} className="animate-float" style={{ animationDelay: `${i * -1.4}s`, transformBox: 'fill-box' }}>
            <circle cx={n.x} cy={n.y} r={n.r + 6} fill={n.color} fillOpacity="0.18" />
            <circle cx={n.x} cy={n.y} r={n.r} fill={n.color} stroke="#FFFFFF" strokeOpacity="0.5" strokeWidth="1.5" />
            <text x={n.x} y={n.y + 4} textAnchor="middle" fontSize={n.r * 0.62} fontWeight="700" fill="#FFFFFF" fontFamily="inherit">
              {n.label}
            </text>
          </g>
        ))}
      </svg>

      {/* Hub */}
      <div className="absolute" style={{ left: `${(HUB.x / 520) * 100}%`, top: `${(HUB.y / 420) * 100}%`, transform: 'translate(-50%,-50%)' }}>
        <span className="absolute inset-0 rounded-[18px] bg-cyan-400/40 animate-pulse-ring" />
        <span className="absolute inset-0 rounded-[18px] bg-cyan-400/30 animate-pulse-ring [animation-delay:1.4s]" />
        <div className="relative rounded-[18px] p-1.5 ring-1 ring-white/20 bg-white/10 backdrop-blur-sm">
          <ConnectMark size={64} />
        </div>
      </div>

      {/* Floating video tiles */}
      <div className="absolute top-[30%] left-[-2%] w-[34%] animate-float-slow">
        <VideoTile name="Ananya R." tone="from-[#1F4A73] to-[#2878E5]" speaking />
      </div>
      <div className="absolute right-[-3%] bottom-[8%] w-[32%] animate-float-slow [animation-delay:-5s]">
        <VideoTile name="Customer" tone="from-[#0E6E7E] to-[#20C4D8]" muted />
      </div>
      <div className="absolute top-[4%] right-[14%] animate-float [animation-delay:-3s]">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/12 px-3 py-1.5 text-[11px] font-semibold text-white ring-1 ring-white/20 backdrop-blur-md">
          <ShieldCheck className="size-3.5 text-cyan-400" /> Encrypted in transit
        </span>
      </div>
    </div>
  )
}

function VideoTile({ name, tone, speaking, muted }: { name: string; tone: string; speaking?: boolean; muted?: boolean }) {
  return (
    <div className={`overflow-hidden rounded-[14px] bg-gradient-to-br ${tone} p-1 shadow-[0_18px_40px_rgb(0_0_0/0.25)] ring-1 ${speaking ? 'ring-cyan-400/80' : 'ring-white/15'}`}>
      <div className="relative flex aspect-video items-center justify-center rounded-[10px] bg-black/10">
        <div className="flex size-9 items-center justify-center rounded-full bg-white/20 text-[12px] font-bold text-white">
          {name.split(' ').map((p) => p[0]).join('')}
        </div>
        <span className="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full bg-black/25">
          <Video className="size-3 text-white" />
        </span>
        <span className="absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-black/30 px-1.5 py-0.5 text-[10px] font-semibold text-white">
          {muted ? <MicOff className="size-2.5 text-[#FCA5A5]" /> : <Mic className="size-2.5 text-cyan-400" />}
          {name}
        </span>
        {speaking && (
          <span className="absolute right-1.5 bottom-1.5 flex items-end gap-[2px]">
            {[6, 10, 7].map((h, i) => (
              <span key={i} className="w-[3px] rounded-full bg-cyan-400 animate-float" style={{ height: h, animationDuration: `${0.9 + i * 0.25}s` }} />
            ))}
          </span>
        )}
      </div>
    </div>
  )
}
