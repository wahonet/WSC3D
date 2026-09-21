"""Real SQLite/file round trips and protection against conflicting USB edits."""
from contextlib import closing
from pathlib import Path
import hashlib
import json
import shutil
import sqlite3
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
import transfer
from app.workspace_lock import workspace_lock

class HandoverTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='wsc-handover-test-')
        self.base=Path(self.temp.name); self.a=self.base/'A'; self.b=self.base/'B'
        self.cache_env=patch.dict('os.environ',{'LOCALAPPDATA':str(self.base/'cache'),
                                              'WSC_CACHE_ROOT':str(self.base/'cache/resources')})
        self.cache_env.start()
        for name in ('config','data/layouts','data/library','resources/stones/示例__武001/images','src/backend','src/frontend'):
            (self.a/name).mkdir(parents=True,exist_ok=True)
        (self.a/'config/project.json').write_text('{"layout_version":3}')
        (self.a/'config/models.json').write_text('{}')
        (self.a/'src/backend/source.py').write_text('version=3')
        (self.a/'data/layouts/xcl.json').write_text('{"position":0}')
        (self.a/'resources/stones/示例__武001/images/a.bin').write_bytes(b'unchanged original')
        self.original='resources/stones/示例__武001/images/original.tif'
        (self.a/self.original).write_bytes(b'original TIFF content')
        with closing(sqlite3.connect(self.a/transfer.DB)) as db:
            db.execute('CREATE TABLE annotations(id INTEGER PRIMARY KEY AUTOINCREMENT,label TEXT)')
            db.execute("INSERT INTO annotations(label) VALUES('original')"); db.commit()
        transfer.initialize(self.a); shutil.copytree(self.a,self.b)

    def tearDown(self):
        self.cache_env.stop()
        self.temp.cleanup()

    def edit(self,root,label):
        with closing(sqlite3.connect(root/transfer.DB)) as db:
            db.execute('UPDATE annotations SET label=?',(label,)); db.commit()

    def export(self,root,name):
        package=self.base/name; transfer.export_package(root,package); return package

    def pack(self,root,names):
        """Create a tiny real pack, without invoking the production packer."""
        folder=(root/transfer.MANIFEST_REL).parent
        folder.mkdir(parents=True,exist_ok=True)
        package=folder/'test-resources.zip'; entries={}
        with zipfile.ZipFile(package,'w',compression=zipfile.ZIP_DEFLATED) as archive:
            for name in names:
                path=root/name; content=path.read_bytes(); stat=path.stat()
                archive.writestr(name,content)
                entries[name]={'pack':package.name,'member':name,
                               'sha256':hashlib.sha256(content).hexdigest(),'bytes':len(content),
                               'mtime_ns':stat.st_mtime_ns,'width':1,'height':1,'fmt':'TIFF'}
        transfer.write_json(root/transfer.MANIFEST_REL,{
            'format':'wsc-resource-packs-1','files':entries,
            'packs':{package.name:{'sha256':transfer.digest(package),'bytes':package.stat().st_size}}})
        for name in names: (root/name).unlink()
        return package

    def test_packing_preserves_logical_fingerprint_and_handover_baseline(self):
        before=transfer.capture(self.a); state=(self.a/transfer.STATE).read_bytes()
        self.pack(self.a,[self.original])
        self.assertEqual(before,transfer.capture(self.a))
        self.assertEqual(state,(self.a/transfer.STATE).read_bytes())
        package=self.export(self.a,'packed-unchanged.zip')
        with zipfile.ZipFile(package) as archive:
            self.assertEqual(set(archive.namelist()),{'handover.json',transfer.DB})
        self.assertTrue(transfer.import_package(self.b,package)['already_imported'])

    def test_new_packed_original_exports_as_original_file(self):
        name='resources/stones/示例__武001/images/new.tif'
        content=b'new independently packed TIFF'
        (self.a/name).write_bytes(content)
        self.pack(self.a,[name])
        package=self.export(self.a,'packed-new.zip')
        with zipfile.ZipFile(package) as archive:
            self.assertEqual(archive.read(name),content)
            self.assertFalse(any(n.startswith('runtime/') for n in archive.namelist()))
        self.assertTrue(transfer.import_package(self.b,package)['imported'])
        self.assertEqual((self.b/name).read_bytes(),content)
        self.assertFalse((self.a/name).exists())
        self.assertEqual(transfer.capture(self.a),transfer.capture(self.b))

    def test_loose_file_overrides_a_packed_original_when_exporting(self):
        self.pack(self.a,[self.original])
        (self.a/self.original).write_bytes(b'updated original')
        package=self.export(self.a,'packed-override.zip')
        with zipfile.ZipFile(package) as archive:
            self.assertEqual(archive.read(self.original),b'updated original')
        transfer.import_package(self.b,package)
        self.assertEqual(transfer.capture(self.a),transfer.capture(self.b))
        self.assertNotIn(self.original,transfer.archived_entries(self.a))
        (self.a/self.original).unlink()
        transfer.import_package(self.b,self.export(self.a,'delete-sender-override.zip'))
        self.assertNotIn(self.original,transfer.capture(self.a)['files'])
        self.assertEqual(transfer.capture(self.a),transfer.capture(self.b))

    def test_packed_recipient_accepts_replacement_then_deletion(self):
        self.pack(self.b,[self.original])
        (self.a/self.original).write_bytes(b'replacement TIFF')
        transfer.import_package(self.b,self.export(self.a,'packed-replacement.zip'))
        self.assertEqual((self.b/self.original).read_bytes(),b'replacement TIFF')
        self.assertNotIn(self.original,transfer.archived_entries(self.b))
        (self.b/self.original).unlink()
        transfer.import_package(self.a,self.export(self.b,'delete-replacement.zip'))
        self.assertNotIn(self.original,transfer.capture(self.b)['files'])
        self.assertEqual(transfer.capture(self.a),transfer.capture(self.b))

    def test_deletion_on_packed_sender_and_recipient_does_not_resurrect(self):
        self.pack(self.a,[self.original]); self.pack(self.b,[self.original])
        transfer.forget_archived([self.original],self.a)
        package=self.export(self.a,'packed-deletion.zip')
        with zipfile.ZipFile(package) as archive:
            self.assertIn(self.original,json.loads(archive.read('handover.json'))['removed'])
        transfer.import_package(self.b,package)
        self.assertNotIn(self.original,transfer.archived_entries(self.b))
        self.assertNotIn(self.original,transfer.capture(self.b)['files'])
        self.assertEqual(transfer.capture(self.a),transfer.capture(self.b))

    def test_missing_pack_is_an_error_not_a_resource_deletion(self):
        package=self.pack(self.a,[self.original]); package.unlink()
        with self.assertRaises(FileNotFoundError): transfer.capture(self.a)

    def test_handover_backup_retains_original_after_unused_pack_cleanup(self):
        import compact_resources
        for action in ('replace','delete'):
            with self.subTest(action=action):
                source=self.base/(action+'-backup-source'); target=self.base/(action+'-backup-target')
                shutil.copytree(self.a,source); shutil.copytree(self.b,target)
                old_pack=self.pack(target,[self.original])
                if action=='replace': (source/self.original).write_bytes(b'replacement TIFF')
                else: (source/self.original).unlink()
                package=self.export(source,action+'-backup.zip')
                result=transfer.import_package(target,package)
                backup=Path(result['backup'])
                receipt=json.loads((backup/'receipt.json').read_text(encoding='utf-8'))
                self.assertIn(self.original,receipt['archived_files'])
                # Cleanup is a subsequent maintenance operation under the same
                # workspace lock; the saved original must not depend on its pack.
                with workspace_lock(target/'data'):
                    self.assertEqual(compact_resources.remove_unreferenced(target),1)
                self.assertFalse(old_pack.exists())
                self.assertEqual((backup/self.original).read_bytes(),b'original TIFF content')
                self.assertEqual(transfer.capture(source),transfer.capture(target))

    def test_failed_packed_import_restores_manifest_and_original_content(self):
        # Exercise both physical replacement rollback and logical deletion rollback.
        for action in ('replace','delete'):
            with self.subTest(action=action):
                source=self.base/(action+'-source'); target=self.base/(action+'-target')
                shutil.copytree(self.a,source); shutil.copytree(self.b,target)
                self.pack(target,[self.original])
                before=transfer.capture(target)
                old_manifest=(target/transfer.MANIFEST_REL).read_bytes()
                if action=='replace': (source/self.original).write_bytes(b'new TIFF')
                else: (source/self.original).unlink()
                self.edit(source,'new annotation')
                package=self.export(source,action+'-failure.zip')
                replace=transfer.os.replace
                def fail(src,dst):
                    if str(src).endswith('.handover-tmp') and str(dst).endswith('stonelab.db'):
                        raise OSError('simulated disk failure')
                    return replace(src,dst)
                with patch.object(transfer.os,'replace',side_effect=fail):
                    with self.assertRaisesRegex(OSError,'disk failure'):
                        transfer.import_package(target,package)
                self.assertEqual(old_manifest,(target/transfer.MANIFEST_REL).read_bytes())
                self.assertFalse((target/self.original).exists())
                self.assertEqual(before,transfer.capture(target))
                self.assertEqual(transfer.extract_resource(target/self.original,target).read_bytes(),
                                 b'original TIFF content')

    def test_creative_results_and_video_jobs_transfer_without_credentials(self):
        files = {'data/creative.sqlite3': b'creative records',
                 'data/creative/works/sample/image.png': b'artwork',
                 'data/video_jobs/sample.json': b'video audit',
                 'resources/creative/materials/sample/image.png': b'published motif'}
        for name, content in files.items():
            path = self.a/name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        (self.a/'config/creative.json').write_text('{"secret":"machine-specific"}')
        package = self.export(self.a, 'creative.zip')
        with zipfile.ZipFile(package) as archive:
            self.assertNotIn('config/creative.json', archive.namelist())
        transfer.import_package(self.b, package)
        for name, content in files.items():
            self.assertEqual((self.b/name).read_bytes(), content)
        self.assertFalse((self.b/'config/creative.json').exists())

    def test_round_trip_tracks_database_new_materials_replacements_and_deletions(self):
        self.edit(self.a,'annotated on A')
        new='resources/stones/示例__武001/images/new.bin'
        (self.a/new).write_bytes(b'new material')
        first=self.export(self.a,'first.zip')
        with zipfile.ZipFile(first) as z:
            self.assertIn(new,z.namelist())
            self.assertNotIn('resources/stones/示例__武001/images/a.bin',z.namelist())
        self.assertTrue(transfer.import_package(self.b,first)['imported'])
        self.assertTrue(transfer.import_package(self.b,first)['already_imported'])
        self.edit(self.b,'corrected on B'); (self.b/new).unlink()
        (self.b/'data/layouts/xcl.json').write_text('{"position":2}')
        second=self.export(self.b,'second.zip'); transfer.import_package(self.a,second)
        self.assertEqual(transfer.capture(self.a)['fingerprint'],transfer.capture(self.b)['fingerprint'])
        self.assertFalse((self.a/new).exists())
        self.assertTrue(list((self.a/'data/backups').glob('handover-*/receipt.json')))

    def test_independent_database_edits_are_rejected_without_overwrite(self):
        self.edit(self.a,'A'); package=self.export(self.a,'conflict.zip'); self.edit(self.b,'B')
        before=transfer.capture(self.b)
        with self.assertRaisesRegex(RuntimeError,'独立修改'): transfer.import_package(self.b,package)
        self.assertEqual(before,transfer.capture(self.b))

    def test_independent_layout_edits_are_rejected(self):
        self.edit(self.a,'A'); package=self.export(self.a,'layout.zip')
        (self.b/'data/layouts/xcl.json').write_text('{"position":5}')
        with self.assertRaisesRegex(RuntimeError,'独立修改'): transfer.import_package(self.b,package)

    def test_newest_package_cannot_skip_an_unimported_handover(self):
        self.edit(self.a,'A1'); self.export(self.a,'one.zip')
        self.edit(self.a,'A2'); second=self.export(self.a,'two.zip')
        with self.assertRaisesRegex(RuntimeError,'上一份'): transfer.import_package(self.b,second)

    def test_different_project_and_software_are_rejected(self):
        self.edit(self.a,'A'); package=self.export(self.a,'other.zip')
        (self.b/'src/backend/source.py').write_text('version=4')
        with self.assertRaisesRegex(ValueError,'程序版本'): transfer.import_package(self.b,package)
        state=transfer.read_state(self.b);state['dataset']='other';transfer.write_json(self.b/transfer.STATE,state)
        with self.assertRaisesRegex(ValueError,'不同'): transfer.import_package(self.b,package)

    def test_tampered_content_and_path_escape_are_rejected(self):
        self.edit(self.a,'A'); original=self.export(self.a,'original.zip')
        with zipfile.ZipFile(original) as archive:
            members={n:archive.read(n) for n in archive.namelist()}
        manifest=json.loads(members['handover.json']);manifest['files']['../escape']={'sha256':'0'*64,'bytes':0}
        members['handover.json']=transfer.encoded(manifest);members['../escape']=b''
        bad=self.base/'bad.zip'
        with zipfile.ZipFile(bad,'w') as archive:
            for n,v in members.items():archive.writestr(n,v)
        before=transfer.capture(self.b)
        with self.assertRaisesRegex(ValueError,'路径'):transfer.import_package(self.b,bad)
        self.assertEqual(before,transfer.capture(self.b))

    def test_running_workspace_lock_prevents_transfer(self):
        with workspace_lock(self.a/'data'):
            with self.assertRaises(RuntimeError):
                with workspace_lock(self.a/'data'): pass

    def test_failed_write_restores_all_existing_work(self):
        self.edit(self.a,'A'); (self.a/'data/layouts/xcl.json').write_text('{"position":2}')
        package=self.export(self.a,'failure.zip');before=transfer.capture(self.b)
        replace=transfer.os.replace
        def fail(source,destination):
            if str(source).endswith('.handover-tmp') and str(destination).endswith('stonelab.db'):raise OSError('simulated disk failure')
            return replace(source,destination)
        with patch.object(transfer.os,'replace',side_effect=fail):
            with self.assertRaisesRegex(OSError,'disk failure'):transfer.import_package(self.b,package)
        self.assertEqual(before,transfer.capture(self.b))

if __name__=='__main__': unittest.main()
