import re

with open("index.html", "r", encoding="utf-8") as f:
    content = f.read()

if "#F3E4C9" in content:
    print("ALREADY DONE: navy/cream light theme block already present. No changes made.")
    raise SystemExit(0)

pattern = re.compile(r"\.light-mode\{[^}]*\}")

new_block = """.light-mode{
  --bg:#F3E4C9; --bg3J#FFFDF8; --bg3:#FAF2E2; --bg4:#F3E4C9;
  --white:#0A2947; --muted:#3D5A73;
  --border:rgba(10,41,71,0.16); --border2:rgba(10,41,71,0.10);
  --gold:#0A2947; --gold-dim:rgba(10,41,71,0.08); --gold-glow:rgba(10,41,71,0.20);
  --gold-text:#F3E4C9; --gold-shade:#04182B;
}
.light-mode.theme-cyan{ --gold:#0E7490; --gold-dim:rgba(14,116,144,0.10); --gold-glow:rgba(14,116,144,0.25); --gold-text:#FFFFFF; }
.light-mode.theme-green{ --gold:#2F7D52; --gold-dim:rgba(47,125,82,0.10); --gold-glow:rgba(47,125,82,0.25); --gold-text:#FFFFFF; }
.light-mode.theme-purple{ --gold:#7B3F96; --gold-dim:rgba(123,63,150,0.10); --gold-glow:rgba(123,63,150,0.25); --gold-text:#FFFFFF; }
.light-mode.theme-steel{ --gold:#3D5A73; --gold-dim:rgba(61,90,115,0.10); --gold-glow:rgba(61,90,115,0.25); --gold-text:#FFFFFF; }

.light-mode .sidebar{background:#0A2947;border-color:rgba(243,228,201,0.12);}
.light-mode .sidebar-logo{border-color:rgba(243,228,201,0.12);}
.light-mode .sidebar-logo-text,.light-mode .sidebar-logo-text span{color:#F3E4C9;}
.light-mode .nav-sec-lbl{color:rgba(243,228,201,0.5);}
.light-mode .nav-item{color:rgba(243,228,201,0.6);}
.light-mode .nav-item:hover{background:rgba(243,228,201,0.08);color:#F3E4C9;}
.light-mode .nav-item.active{background:#F3E4C9;color:#0A2947;border:none;border-radius:10px;box-shadow:none;}
.light-mode .sidebar-bottom{border-color:rgba(243,228,201,0.12);}
.light-mode .sidebar-user:hover{background:rgba(243,228,201,0.08);}
.light-mode .user-nm{color:#F3E4C9;}
.light-mode .user-role{color:rgba(243,228,201,0.55);}
.light-mode .topbar{background:rgba(10,41,71,0.94);border-color:rgba(243,228,201,0.12);}
.light-mode .mob-menu{background:rgba(243,228,201,0.08);border-color:rgba(243,228,201,0.25);color:#F3E4C9;}
.light-mode .broker-sel{background:rgba(243,228,201,0.06);border-color:rgba(243,228,201,0.18);color:#F3E4C9;}
.light-mode .b-nm{color:#F3E4C9;}
.light-mode .nav{background:rgba(10,41,71,0.92);}
.light-mode .nav-link{color:rgba(243,228,201,0.6);}
.light-mode .nav-link:hover{color:#F3E4C9;}
.light-mode .logo-text,.light-mode .logo-text span{color:#F3E4C9;}
.light-mode .btn-ghost{color:#F3E4C9;border-color:rgba(243,228,201,0.25);}
.light-mode .mobile-nav{background:rgba(10,41,71,0.97);border-color:rgba(243,228,201,0.12);}
.light-mode .mn-item{color:rgba(243,228,201,0.5);}
.light-mode .mn-item.active{color:#F3E4C9;}
.light-mode .mn-center-btn{background:#F3E4C9;color:#0A2947;}
.light-mode .auth-left .auth-tagline{color:#F3E4C9;}
.light-mode .auth-left .auth-feat-text{color:rgba(243,228,201,0.65);}
.light-mode .auth-left-name{color:#F3E4C9;}"""

new_content, n = pattern.subn(new_block, content, count=1)

if n == 0:
    print("ERROR: could not find a '.light-mode{...}' rule in index.html. Aborting, no changes made.")
    raise SystemExit(1)

with open("index.html", "w", encoding="utf-8") as f:
    f.write(new_content)

print("SUCCESS: light-mode navy/cream block inserted.")
