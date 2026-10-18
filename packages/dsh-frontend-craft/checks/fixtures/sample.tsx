export function Card({ title }: { title: string }) {
  return (
    <div
      style={{
        borderLeft: '4px solid #6366f1',
        borderRadius: 12,
        background: 'linear-gradient(90deg, #7c3aed, #3b82f6)',
      }}
    >
      <span style={{ backgroundClip: 'text', WebkitBackgroundClip: 'text', color: 'transparent' }}>{title}</span>
    </div>
  )
}
