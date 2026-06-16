import { Warp } from "@paper-design/shaders-react"

export default function WarpBackground() {
  return (
    <div
      className="fixed inset-0 z-0 overflow-hidden pointer-events-none"
      aria-hidden="true"
    >
      <Warp
        style={{
          width: "100%",
          height: "100%",
        }}
        proportion={0.45}
        softness={1}
        distortion={0.25}
        swirl={0.8}
        swirlIterations={10}
        shape="checks"
        shapeScale={0.1}
        scale={1}
        rotation={0}
        speed={1}
        colors={[
          "hsl(200, 100%, 20%)",
          "hsl(160, 100%, 75%)",
          "hsl(180, 90%, 30%)",
          "hsl(170, 100%, 80%)",
        ]}
      />

      <div className="absolute inset-0 bg-slate-950/25" />
    </div>
  )
}