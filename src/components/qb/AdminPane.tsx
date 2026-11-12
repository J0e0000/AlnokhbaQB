'use client';

// ============================================================
// ALNOKHBA QB — Admin pane (org_admin / super_admin)
// Users & roles management, audit log, organisations (super only).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Building2, KeyRound, Loader2, Plus, RefreshCw, ScrollText, ShieldCheck, UserCog, Users,
} from 'lucide-react';

interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  lastLoginAt: string | null;
  organizationId: string | null;
  organizationName: string | null;
}
interface AuditEntry {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  userEmail: string | null;
  meta: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}
interface Org { id: string; name: string; userCount: number; activeUsers: number }

const ROLE_LABEL: Record<string, string> = {
  super_admin: 'مدير النظام',
  org_admin: 'مدير المؤسسة',
  teacher: 'معلم / محرر',
  viewer: 'مشاهد',
};

const ACTION_LABEL: Record<string, string> = {
  login: 'تسجيل دخول',
  'login.failed': 'دخول فاشل',
  logout: 'خروج',
  register: 'تسجيل مؤسسة',
  'user.create': 'إنشاء مستخدم',
  'user.update': 'تعديل مستخدم',
  'exam.publish': 'نشر امتحان',
  'exam.archive': 'أرشفة امتحان',
  'scan.process': 'مسح ورقة',
  'scan.review': 'مراجعة ورقة',
  'question.import': 'استيراد أسئلة',
  'question.export': 'تصدير بنك',
  'extract.run': 'استخراج ذكي',
  'document.upload': 'رفع مستند',
  'student.create': 'إضافة طالب',
};

export default function AdminPane({ sessionRole, sessionOrgId }: { sessionRole: string; sessionOrgId: string | null }) {
  const isSuper = sessionRole === 'super_admin';

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'teacher' });
  const [saving, setSaving] = useState(false);

  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loadingAudit, setLoadingAudit] = useState(true);
  const [actionFilter, setActionFilter] = useState('all');

  const [orgs, setOrgs] = useState<Org[]>([]);

  const loadUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const res = await fetch('/api/admin/users');
      if (res.ok) setUsers((await res.json()).users ?? []);
    } finally {
      setLoadingUsers(false);
    }
  }, []);

  const loadAudit = useCallback(async () => {
    setLoadingAudit(true);
    try {
      const res = await fetch(`/api/admin/audit?limit=150${actionFilter !== 'all' ? `&action=${actionFilter}` : ''}`);
      if (res.ok) setEntries((await res.json()).entries ?? []);
    } finally {
      setLoadingAudit(false);
    }
  }, [actionFilter]);

  const loadOrgs = useCallback(async () => {
    if (!isSuper) return;
    try {
      const res = await fetch('/api/admin/orgs');
      if (res.ok) setOrgs((await res.json()).organizations ?? []);
    } catch { /* optional */ }
  }, [isSuper]);

  useEffect(() => {
    void loadUsers();
    void loadAudit();
    void loadOrgs();
  }, [loadUsers, loadAudit, loadOrgs]);

  const createUser = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.error ?? 'تعذر إنشاء المستخدم'); return; }
      toast.success(`تم إنشاء ${data.name} (${ROLE_LABEL[data.role] ?? data.role})`);
      setCreateOpen(false);
      setForm({ name: '', email: '', password: '', role: 'teacher' });
      void loadUsers();
    } finally {
      setSaving(false);
    }
  };

  const patchUser = async (id: string, patch: Record<string, unknown>, okMsg: string) => {
    const res = await fetch(`/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast.error(data.error ?? 'تعذر التعديل'); void loadUsers(); return; }
    toast.success(okMsg);
    void loadUsers();
  };

  const resetPassword = async (u: AdminUser) => {
    const pw = window.prompt(`كلمة مرور جديدة للمستخدم ${u.name} (٨ أحرف على الأقل):`);
    if (!pw) return;
    if (pw.length < 8) { toast.error('كلمة المرور قصيرة جدًا'); return; }
    await patchUser(u.id, { password: pw }, 'تم تعيين كلمة المرور الجديدة');
  };

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-extrabold text-slate-800">
          <ShieldCheck className="h-5 w-5 text-emerald-600" /> الإدارة
          <Badge variant="outline" className="text-[10px]">{isSuper ? 'مدير النظام — كل المؤسسات' : 'مدير المؤسسة'}</Badge>
        </h2>
      </div>

      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users" className="gap-1.5"><Users className="h-4 w-4" /> المستخدمون</TabsTrigger>
          <TabsTrigger value="audit" className="gap-1.5"><ScrollText className="h-4 w-4" /> سجل التدقيق</TabsTrigger>
          {isSuper && <TabsTrigger value="orgs" className="gap-1.5"><Building2 className="h-4 w-4" /> المؤسسات</TabsTrigger>}
        </TabsList>

        {/* ---- users ---- */}
        <TabsContent value="users">
          <Card>
            <CardContent className="p-0">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <span className="text-xs font-bold text-slate-500">{users.length} مستخدمًا</span>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" className="h-8 gap-1" onClick={() => void loadUsers()}><RefreshCw className="h-3.5 w-3.5" /> تحديث</Button>
                  <Button size="sm" className="h-8 gap-1 bg-emerald-600 hover:bg-emerald-700" onClick={() => setCreateOpen(true)}><Plus className="h-3.5 w-3.5" /> مستخدم جديد</Button>
                </div>
              </div>
              {loadingUsers ? (
                <div className="flex justify-center py-14 text-slate-300"><Loader2 className="h-7 w-7 animate-spin" /></div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-right text-xs">
                    <thead>
                      <tr className="border-b bg-slate-50 text-slate-500">
                        <th className="px-3 py-2 font-bold">الاسم</th>
                        <th className="px-3 py-2 font-bold">البريد</th>
                        <th className="px-3 py-2 font-bold">الدور</th>
                        {isSuper && <th className="px-3 py-2 font-bold">المؤسسة</th>}
                        <th className="px-3 py-2 font-bold">آخر دخول</th>
                        <th className="px-3 py-2 font-bold">نشط</th>
                        <th className="px-3 py-2 font-bold">إجراءات</th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((u) => (
                        <tr key={u.id} className="border-b last:border-0 hover:bg-slate-50/60">
                          <td className="px-3 py-2.5 font-bold text-slate-700">{u.name}</td>
                          <td className="px-3 py-2.5 font-mono text-[11px] text-slate-500" dir="ltr">{u.email}</td>
                          <td className="px-3 py-2.5">
                            <Select value={u.role} onValueChange={(v) => void patchUser(u.id, { role: v }, `تم تغيير دور ${u.name}`)}>
                              <SelectTrigger className="h-7 w-32 text-[11px]"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {(isSuper ? ['super_admin', 'org_admin', 'teacher', 'viewer'] : ['org_admin', 'teacher', 'viewer']).map((r) => (
                                  <SelectItem key={r} value={r}>{ROLE_LABEL[r]}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </td>
                          {isSuper && <td className="px-3 py-2.5 text-slate-500">{u.organizationName ?? '—'}</td>}
                          <td className="px-3 py-2.5 text-[11px] text-slate-400">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('ar') : 'لم يسجل بعد'}</td>
                          <td className="px-3 py-2.5">
                            <Switch checked={u.active} onCheckedChange={(v) => void patchUser(u.id, { active: v }, v ? `تم تنشيط ${u.name}` : `تم تعطيل ${u.name}`)} aria-label={`تنشيط ${u.name}`} />
                          </td>
                          <td className="px-3 py-2.5">
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="إعادة تعيين كلمة المرور" onClick={() => void resetPassword(u)}>
                              <KeyRound className="h-3.5 w-3.5 text-slate-400" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- audit ---- */}
        <TabsContent value="audit">
          <Card>
            <CardContent className="p-0">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
                <span className="text-xs font-bold text-slate-500">آخر {entries.length} حدثًا</span>
                <div className="flex gap-2">
                  <Select value={actionFilter} onValueChange={(v) => setActionFilter(v)}>
                    <SelectTrigger className="h-8 w-44 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">كل الأحداث</SelectItem>
                      {Object.entries(ACTION_LABEL).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Button size="sm" variant="outline" className="h-8 gap-1" onClick={() => void loadAudit()}><RefreshCw className="h-3.5 w-3.5" /> تحديث</Button>
                </div>
              </div>
              {loadingAudit ? (
                <div className="flex justify-center py-14 text-slate-300"><Loader2 className="h-7 w-7 animate-spin" /></div>
              ) : entries.length === 0 ? (
                <div className="py-14 text-center text-xs text-slate-400">لا توجد أحداث مطابقة</div>
              ) : (
                <div className="max-h-[60vh] overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                  <table className="w-full text-right text-xs">
                    <thead className="sticky top-0 bg-slate-50">
                      <tr className="border-b text-slate-500">
                        <th className="px-3 py-2 font-bold">الحدث</th>
                        <th className="px-3 py-2 font-bold">الكيان</th>
                        <th className="px-3 py-2 font-bold">المستخدم</th>
                        <th className="px-3 py-2 font-bold">تفاصيل</th>
                        <th className="px-3 py-2 font-bold">الوقت</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map((e) => (
                        <tr key={e.id} className="border-b last:border-0 hover:bg-slate-50/60">
                          <td className="px-3 py-2">
                            <Badge variant={e.action.includes('failed') ? 'destructive' : e.action === 'login' || e.action === 'logout' ? 'secondary' : 'outline'} className="text-[10px]">
                              {ACTION_LABEL[e.action] ?? e.action}
                            </Badge>
                          </td>
                          <td className="px-3 py-2 text-slate-500">{e.entity}</td>
                          <td className="px-3 py-2 font-mono text-[10px] text-slate-400" dir="ltr">{e.userEmail ?? '—'}</td>
                          <td className="max-w-[260px] truncate px-3 py-2 text-[10px] text-slate-400">{Object.keys(e.meta ?? {}).length ? JSON.stringify(e.meta) : '—'}</td>
                          <td className="px-3 py-2 text-[10px] text-slate-400">{new Date(e.createdAt).toLocaleString('ar')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- orgs ---- */}
        {isSuper && (
          <TabsContent value="orgs">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {orgs.map((o) => (
                <Card key={o.id}>
                  <CardContent className="flex items-center gap-3 p-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600"><Building2 className="h-5 w-5" /></div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-bold text-slate-700">{o.name}</div>
                      <div className="text-[11px] text-slate-400">{o.activeUsers} نشط من {o.userCount} مستخدم</div>
                    </div>
                  </CardContent>
                </Card>
              ))}
              {orgs.length === 0 && <div className="col-span-full py-10 text-center text-xs text-slate-400">لا توجد مؤسسات</div>}
            </div>
          </TabsContent>
        )}
      </Tabs>

      {/* create user dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><UserCog className="h-4 w-4 text-emerald-600" /> إضافة مستخدم</DialogTitle>
            <DialogDescription className="text-right">أنشئ حسابًا جديدًا وحدد دوره وصلاحياته داخل المؤسسة.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">الاسم</Label>
              <Input className="h-9 text-sm" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">البريد الإلكتروني</Label>
              <Input className="h-9 text-left text-sm" dir="ltr" type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">كلمة المرور (٨+ أحرف)</Label>
              <Input className="h-9 text-left text-sm" dir="ltr" type="text" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">الدور</Label>
              <Select value={form.role} onValueChange={(v) => setForm((f) => ({ ...f, role: v }))}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(isSuper ? ['org_admin', 'teacher', 'viewer', 'super_admin'] : ['org_admin', 'teacher', 'viewer']).map((r) => (
                    <SelectItem key={r} value={r}>{ROLE_LABEL[r]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {!isSuper && <p className="text-[10px] text-slate-400">سيُضاف المستخدم إلى مؤسستك الحالية فقط.</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>إلغاء</Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700" disabled={saving || !form.name.trim() || !form.email.trim() || form.password.length < 8} onClick={() => void createUser()}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} إنشاء
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
