import { type ReactNode } from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { ThemeProvider } from "./context/ThemeContext";

// Re-export everything from testing-library
export * from "@testing-library/react";
export { default as userEvent } from "@testing-library/user-event";

interface WrapperProps {
  children: ReactNode;
}

/**
 * Renders a component wrapped in MemoryRouter + AuthProvider.
 * Use `initialEntries` to control the starting route.
 */
export function renderWithProviders(
  ui: React.ReactElement,
  options?: RenderOptions & { initialEntries?: string[] },
) {
  const { initialEntries = ["/"], ...renderOptions } = options ?? {};

  function Wrapper({ children }: WrapperProps) {
    return (
      <MemoryRouter initialEntries={initialEntries}>
        <ThemeProvider>
          <AuthProvider>{children}</AuthProvider>
        </ThemeProvider>
      </MemoryRouter>
    );
  }

  return render(ui, { wrapper: Wrapper, ...renderOptions });
}

/**
 * Renders a component wrapped in MemoryRouter only (no AuthProvider).
 * Useful for testing components that manage their own auth context or
 * when you want to provide a custom mock AuthProvider.
 */
export function renderWithRouter(
  ui: React.ReactElement,
  options?: RenderOptions & { initialEntries?: string[] },
) {
  const { initialEntries = ["/"], ...renderOptions } = options ?? {};

  function Wrapper({ children }: WrapperProps) {
    return <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>;
  }

  return render(ui, { wrapper: Wrapper, ...renderOptions });
}
