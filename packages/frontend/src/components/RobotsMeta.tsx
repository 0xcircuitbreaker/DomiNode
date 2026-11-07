import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/** Private (admin and auth) paths must never be indexed. */
export const PRIVATE_PREFIXES = ["/admin", "/login", "/forgot-password", "/reset-password", "/verify-email"];

export function isPrivatePath(pathname: string): boolean {
  return PRIVATE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Adds <meta name="robots" content="noindex"> on private routes, removes it elsewhere. */
export default function RobotsMeta() {
  const { pathname } = useLocation();
  useEffect(() => {
    const id = "dn-robots-noindex";
    const existing = document.getElementById(id);
    if (isPrivatePath(pathname)) {
      if (!existing) {
        const m = document.createElement("meta");
        m.id = id;
        m.name = "robots";
        m.content = "noindex, nofollow";
        document.head.appendChild(m);
      }
    } else {
      existing?.remove();
    }
  }, [pathname]);
  return null;
}
