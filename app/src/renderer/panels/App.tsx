import { zh } from '../../shared/strings.zh-CN';

export function App() {
  return (
    <main>
      <h1>{zh.app.name}</h1>
      <p data-testid="placeholder">{zh.app.panelsPlaceholder}</p>
    </main>
  );
}
