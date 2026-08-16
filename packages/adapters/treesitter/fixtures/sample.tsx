import { useState } from "react";

export function App(): unknown {
  const [count] = useState(0);
  return <div>{count}</div>;
}

export const Panel = () => <span />;
