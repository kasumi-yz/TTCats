import type { ContentCatalog } from '../../shared/core-api';
import { zh } from '../../shared/strings.zh-CN';

const text = zh.panels;

export function ProfilePanel({
  content,
  catId,
  at,
}: {
  content: ContentCatalog;
  catId: string | null;
  at: number;
}) {
  const cat = catId ? content.cats[catId]?.cat : undefined;
  if (!cat) return <p role="status">{text.catMissing}</p>;
  let age = text.unknown;
  if (cat.birthday) {
    const today = new Date(at);
    const birth = new Date(`${cat.birthday}T00:00:00`);
    const anniversaryPassed =
      today.getMonth() > birth.getMonth() ||
      (today.getMonth() === birth.getMonth() && today.getDate() >= birth.getDate());
    const years = today.getFullYear() - birth.getFullYear() - (anniversaryPassed ? 0 : 1);
    age = birth.getTime() > at ? text.notBorn : text.ageYears(years);
  }
  return (
    <section className="card">
      <h2>{cat.name}</h2>
      <dl>
        <dt>{text.birthday}</dt>
        <dd>{cat.birthday ?? text.unknown}</dd>
        <dt>{text.homeDate}</dt>
        <dd>{cat.homeDate ?? text.unknown}</dd>
        <dt>{text.age}</dt>
        <dd>{age}</dd>
      </dl>
      <h3>{text.personality}</h3>
      {Object.entries(cat.personality).map(([key, value]) => (
        <label className="field" key={key}>
          {text.personalityLabels[key as keyof typeof cat.personality]}
          <span>{Math.round(value * 100)}%</span>
          <meter min="0" max="1" value={value} />
        </label>
      ))}
    </section>
  );
}
