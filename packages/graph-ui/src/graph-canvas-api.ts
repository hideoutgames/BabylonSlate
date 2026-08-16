export type GraphCanvasDropApi = {
  containsClientPoint(clientX: number, clientY: number): boolean;
  clientToFlow(clientX: number, clientY: number): { x: number; y: number };
};

function pointInRect(
  clientX: number,
  clientY: number,
  rect: DOMRect,
): boolean {
  return (
    clientX >= rect.left &&
    clientX <= rect.right &&
    clientY >= rect.top &&
    clientY <= rect.bottom
  );
}

/** Client hit-test + React Flow conversion for tree drops onto the graph. */
export function createGraphCanvasDropApi(
  element: HTMLElement | null,
  clientToFlow: (point: { x: number; y: number }) => { x: number; y: number },
): GraphCanvasDropApi {
  return {
    containsClientPoint(clientX, clientY) {
      if (!element) return false;
      return pointInRect(clientX, clientY, element.getBoundingClientRect());
    },
    clientToFlow(clientX, clientY) {
      return clientToFlow({ x: clientX, y: clientY });
    },
  };
}
