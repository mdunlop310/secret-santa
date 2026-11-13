import { Route, Routes } from 'react-router-dom'
import { NotFoundPage } from './components/States'
import { CreateGroupPage } from './pages/CreateGroup'
import { DashboardPage } from './pages/Dashboard'
import { EnterPage } from './pages/Enter'
import { ExclusionsPage } from './pages/Exclusions'
import { GifteePage } from './pages/Giftee'
import { GroupDeletedPage, LeftPage, UnsubscribePage } from './pages/Unsubscribe'
import { CheckEmailPage, JoinPage } from './pages/Join'
import { LostLinkPage, OpenLinkPage } from './pages/Links'
import { WishListPage } from './pages/WishList'

export function App() {
  return (
    <Routes>
      <Route path="/" element={<EnterPage />} />
      <Route path="/new" element={<CreateGroupPage />} />
      <Route path="/g/:adminToken" element={<DashboardPage />} />
      <Route path="/g/:adminToken/exclusions" element={<ExclusionsPage />} />
      {/* The organiser's own wish list and giftee, on the same link. */}
      <Route path="/g/:adminToken/wishlist" element={<WishListPage />} />
      <Route path="/g/:adminToken/giftee" element={<GifteePage />} />
      <Route path="/join/:inviteToken" element={<JoinPage />} />
      <Route path="/join/:inviteToken/check-email" element={<CheckEmailPage />} />
      <Route path="/p/:participantToken" element={<WishListPage />} />
      <Route path="/p/:participantToken/giftee" element={<GifteePage />} />
      <Route path="/open/:token" element={<OpenLinkPage />} />
      <Route path="/lost" element={<LostLinkPage />} />
      <Route path="/unsubscribe/:token" element={<UnsubscribePage />} />
      <Route path="/left" element={<LeftPage />} />
      <Route path="/deleted" element={<GroupDeletedPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}
