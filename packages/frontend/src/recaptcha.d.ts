interface ReCaptchaInstance {
  render(container: HTMLElement, params: { sitekey: string; theme?: string }): number;
  getResponse(widgetId?: number): string;
  reset(widgetId?: number): void;
}

interface Window {
  grecaptcha?: ReCaptchaInstance;
}
