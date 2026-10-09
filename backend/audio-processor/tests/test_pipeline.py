"""Pipeline invariants run inside the deployed CPU image."""
import unittest
from unittest.mock import patch
import numpy as np
import parselmouth
from pipeline import acoustic, ctc_words, intervals, choose_end, RATE

class Tokenizer:
    def decode(self, labels):
        return {0:'д',1:'а',2:' '}[labels[0]]

class Model:
    blank=3
    tokenizer=Tokenizer()
    def __init__(self, labels):self.output=np.array(labels)
    def labels(self, samples):
        if samples.size>20*RATE:raise AssertionError('unbounded model input')
        return self.output

class PipelineTest(unittest.TestCase):
    def test_context_frames_are_owned_once_and_true_repetition_survives(self):
        state={'lastToken':3,'pendingWord':'','pendingStart':0}
        first=[3]*20;first[16:19]=[0,1,2]
        output=ctc_words(Model(first),np.zeros(20*RATE,dtype=np.float32),0,0,18*RATE,state,False)
        self.assertEqual([],output)
        second=[1,2,0,1,2]+[3]*15
        output=ctc_words(Model(second),np.zeros(20*RATE,dtype=np.float32),17*RATE,18*RATE,36*RATE,state,True)
        self.assertEqual(['да','да'],[x['text'] for x in output])
        self.assertEqual([(16,18),(19,21)],[(x['start'],x['end']) for x in output])

    def test_final_word_does_not_extend_across_trailing_silence(self):
        state={'lastToken':3,'pendingWord':'','pendingStart':0}
        output=ctc_words(Model([0,1]+[3]*18),np.zeros(20*RATE,dtype=np.float32),0,0,20*RATE,state,True)
        self.assertEqual([{'start':0,'end':2,'text':'да','timing':'ctc_estimate'}],output)

    def test_silence_is_finite_and_missing_pitch_is_explicit(self):
        state={}
        rows=acoustic(np.zeros(3*RATE,dtype=np.float32),0,0,3*RATE,state)
        loudness=[x for x in rows if x['kind']=='loudness']
        pitch=[x for x in rows if x['kind']=='pitch']
        self.assertEqual(60,len(loudness));self.assertEqual(300,len(pitch))
        self.assertTrue(all(x['rmsDbfs'] is None and x['peakDbfs'] is None and x['digitalSilence'] for x in loudness))
        self.assertTrue(all(x['f0Hz'] is None and x['reason'] and x['deltaHz'] is None for x in pitch))
        self.assertEqual(0,pitch[0]['start']);self.assertAlmostEqual(2.99,pitch[-1]['start'])

    def test_pause_partition_keeps_initial_and_final_silence(self):
        self.assertEqual([{'start':0,'end':1,'kind':'pause'},{'start':1,'end':2,'kind':'speech'},
            {'start':2,'end':3,'kind':'pause'}],intervals(0,3*RATE,[(RATE,2*RATE)]))
        cut=choose_end(0,18*RATE,[{'start':17.12,'end':17.95,'kind':'pause'}],False)
        self.assertEqual(0,cut%3200)

    def test_pitch_windows_bound_praat_workers_and_keep_frequency(self):
        signal = np.sin(2*np.pi*200*np.arange(3*RATE)/RATE).astype(np.float32)
        original = parselmouth.Sound
        def bounded_sound(samples, rate):
            self.assertLessEqual(len(samples), int(.6*RATE))
            return original(samples, rate)
        with patch('pipeline.parselmouth.Sound', side_effect=bounded_sound):
            rows = acoustic(signal, 0, 0, len(signal), {})
        pitch = [x for x in rows if x['kind']=='pitch' and x['f0Hz'] is not None]
        self.assertGreater(len(pitch), 280)
        self.assertTrue(all(abs(x['f0Hz']-200)<1 for x in pitch))

if __name__=='__main__':unittest.main(verbosity=2)
