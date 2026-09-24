import { Link } from 'react-router-dom'
import { IconInbox, IconPlug, IconTrendingUp, IconUsers } from '../components/icons'
import Marquee from '../components/Marquee'

const metrics = [
  { label: 'Ліди сьогодні', value: '0', icon: IconUsers },
  { label: 'Активні треди', value: '0', icon: IconInbox },
  { label: 'Конверсія', value: '0%', icon: IconTrendingUp },
]

export default function Dashboard() {
  return (
    <div className="page fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Дашборд</h1>
          <p className="page-description">Огляд активності по лідах і тредах</p>
        </div>
      </div>

      <div className="metric-grid">
        {metrics.map(({ label, value, icon: Icon }) => (
          <div className="card metric-card" key={label}>
            <div className="metric-card-top">
              <span className="metric-label">{label}</span>
              <span className="metric-icon">
                <Icon size={17} />
              </span>
            </div>
            <span className="metric-value">{value}</span>
            <span className="metric-trend">Дані з&rsquo;являться після підключення каналу</span>
          </div>
        ))}
      </div>

      <div className="empty-state">
        <Marquee />
        <span className="empty-state-icon">
          <IconPlug size={22} />
        </span>
        <h3>Підключіть канал, щоб почати</h3>
        <p>Лідів ще немає. Додайте Telegram-бота в налаштуваннях — і нові звернення почнуть з&rsquo;являтися тут автоматично.</p>
        <Link to="/dashboard/settings" className="btn btn-primary">
          Підключити канал
        </Link>
      </div>
    </div>
  )
}
