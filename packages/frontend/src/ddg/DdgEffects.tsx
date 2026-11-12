import Crosshair from "./Crosshair";
import GrainCanvas from "./GrainCanvas";

/** Mount once per layout: living grain plus the crosshair cursor. */
export default function DdgEffects({ grainOpacity, crosshair = true }: { grainOpacity?: number; crosshair?: boolean }) {
  return (
    <>
      <GrainCanvas opacity={grainOpacity} />
      {crosshair && <Crosshair />}
    </>
  );
}
