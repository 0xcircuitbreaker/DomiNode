import { useEffect, useRef } from "react";
import type { ThemeMode } from "../context/ThemeContext";

interface NodeNetworkBackgroundProps {
  theme: ThemeMode;
  className?: string;
}

interface NetworkNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

interface PointerState {
  x: number;
  y: number;
  active: boolean;
}

interface NetworkPalette {
  node: [number, number, number];
  line: [number, number, number];
  spoke: [number, number, number];
  glow: [number, number, number];
}

const LIGHT_PALETTE: NetworkPalette = {
  node: [13, 43, 74],
  line: [26, 63, 97],
  spoke: [11, 95, 89],
  glow: [15, 118, 110],
};

const DARK_PALETTE: NetworkPalette = {
  node: [232, 241, 252],
  line: [188, 216, 248],
  spoke: [167, 243, 234],
  glow: [125, 211, 252],
};

function randomVelocity(): number {
  return (Math.random() - 0.5) * 0.45;
}

function createNode(width: number, height: number): NetworkNode {
  return {
    x: Math.random() * width,
    y: Math.random() * height,
    vx: randomVelocity(),
    vy: randomVelocity(),
    radius: 1.2 + Math.random() * 1.9,
  };
}

function alphaColor([r, g, b]: [number, number, number], alpha: number): string {
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export default function NodeNetworkBackground({ theme, className = "" }: NodeNetworkBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (typeof navigator !== "undefined" && navigator.userAgent.toLowerCase().includes("jsdom")) {
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const palette = theme === "dark" ? DARK_PALETTE : LIGHT_PALETTE;

    let animationFrame = 0;
    let width = 0;
    let height = 0;
    let connectionDistance = 128;
    let nodes: NetworkNode[] = [];
    const pointer: PointerState = { x: 0, y: 0, active: false };

    const onPointerMove = (event: PointerEvent) => {
      pointer.active = true;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
    };

    const onPointerLeave = () => {
      pointer.active = false;
    };

    const updateCanvasSize = () => {
      const dpr = window.devicePixelRatio || 1;
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      connectionDistance = Math.min(168, Math.max(112, width * 0.12));

      const targetCount = Math.min(130, Math.max(36, Math.round((width * height) / 22000)));
      if (nodes.length < targetCount) {
        for (let i = nodes.length; i < targetCount; i += 1) {
          nodes.push(createNode(width, height));
        }
      } else if (nodes.length > targetCount) {
        nodes = nodes.slice(0, targetCount);
      }
    };

    const drawFrame = (timestampMs: number) => {
      context.clearRect(0, 0, width, height);

      for (const node of nodes) {
        if (!prefersReducedMotion) {
          node.x += node.vx;
          node.y += node.vy;

          if (pointer.active) {
            const dx = node.x - pointer.x;
            const dy = node.y - pointer.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const influenceRadius = 180;
            if (distance > 0 && distance < influenceRadius) {
              const repulsion = (1 - distance / influenceRadius) * 0.14;
              node.vx += (dx / distance) * repulsion;
              node.vy += (dy / distance) * repulsion;
            }
          }

          node.vx = clamp(node.vx, -0.62, 0.62);
          node.vy = clamp(node.vy, -0.62, 0.62);
          if (Math.abs(node.vx) < 0.05) {
            node.vx = node.vx >= 0 ? 0.05 : -0.05;
          }
          if (Math.abs(node.vy) < 0.05) {
            node.vy = node.vy >= 0 ? 0.05 : -0.05;
          }

          if (node.x < 0 || node.x > width) {
            node.vx *= -1;
            node.x = Math.min(Math.max(node.x, 0), width);
          }

          if (node.y < 0 || node.y > height) {
            node.vy *= -1;
            node.y = Math.min(Math.max(node.y, 0), height);
          }
        }
      }

      const maxDistanceSq = connectionDistance * connectionDistance;
      for (let i = 0; i < nodes.length; i += 1) {
        const first = nodes[i];
        if (!first) continue;
        for (let j = i + 1; j < nodes.length; j += 1) {
          const second = nodes[j];
          if (!second) continue;
          const dx = first.x - second.x;
          const dy = first.y - second.y;
          const distanceSq = dx * dx + dy * dy;
          if (distanceSq > maxDistanceSq) continue;

          const distance = Math.sqrt(distanceSq);
          const opacity = (1 - distance / connectionDistance) * (theme === "dark" ? 0.36 : 0.2);
          context.beginPath();
          context.moveTo(first.x, first.y);
          context.lineTo(second.x, second.y);
          context.strokeStyle = alphaColor(palette.line, opacity);
          context.lineWidth = 1;
          context.stroke();
        }
      }

      for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i];
        if (!node) continue;
        const pulse = 0.55 + Math.sin(timestampMs * 0.0011 + i * 0.8) * 0.24;
        const nodeOpacity = theme === "dark" ? 0.85 : 0.66;

        context.beginPath();
        context.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        context.fillStyle = alphaColor(palette.node, nodeOpacity);
        context.fill();

        context.beginPath();
        context.arc(node.x, node.y, node.radius * (1.8 + pulse * 0.7), 0, Math.PI * 2);
        context.fillStyle = alphaColor(palette.glow, theme === "dark" ? 0.11 : 0.08);
        context.fill();

        context.strokeStyle = alphaColor(palette.spoke, theme === "dark" ? 0.42 : 0.28);
        context.lineWidth = 1;
        const spokeBaseAngle = timestampMs * 0.0006 + i;
        for (let spokeIndex = 0; spokeIndex < 3; spokeIndex += 1) {
          const angle = spokeBaseAngle + spokeIndex * ((Math.PI * 2) / 3);
          const start = node.radius + 0.9;
          const length = 2.6 + pulse * 1.6;
          const x1 = node.x + Math.cos(angle) * start;
          const y1 = node.y + Math.sin(angle) * start;
          const x2 = node.x + Math.cos(angle) * (start + length);
          const y2 = node.y + Math.sin(angle) * (start + length);
          context.beginPath();
          context.moveTo(x1, y1);
          context.lineTo(x2, y2);
          context.stroke();
        }
      }
    };

    const animate = (timestampMs: number) => {
      drawFrame(timestampMs);
      animationFrame = window.requestAnimationFrame(animate);
    };

    updateCanvasSize();
    drawFrame(0);
    if (!prefersReducedMotion) {
      animationFrame = window.requestAnimationFrame(animate);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerleave", onPointerLeave);
    window.addEventListener("pointercancel", onPointerLeave);
    window.addEventListener("resize", updateCanvasSize);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("pointercancel", onPointerLeave);
      window.removeEventListener("resize", updateCanvasSize);
      if (animationFrame) {
        window.cancelAnimationFrame(animationFrame);
      }
    };
  }, [theme]);

  return <canvas ref={canvasRef} className={`node-network-bg ${className}`.trim()} aria-hidden="true" />;
}
